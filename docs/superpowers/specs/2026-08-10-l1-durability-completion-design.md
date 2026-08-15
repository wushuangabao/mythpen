# L1 耐久性收尾设计：原生项目 SQLite 与用户可恢复入口

日期：2026-08-10（第 8 版修订：2026-08-11）

状态：已确认的设计基线（第 8 版；实施状态见 §20）

上游范围：2026-08-06-manuscript-durability-and-versioning-v1-scope.md

上游计划：../plans/2026-08-06-l1-durability-foundation.md

性能证据：../plans/l1-benchmarks.md

## 1. 本文定位

本文只收敛 L1 中尚未完成的三项工作：

1. Task 8 的诊断、恢复与用户出口；
2. Task 6 的项目数据库原生 SQLite 性能重构；
3. POSIX missing-formal verified install 的剩余平台边界。

第 4 版根据 2026-08-10 新一轮审查主动缩小范围。第 3 版为防止未发布构建误激活、旧版本降级和路径变化，引入了签名 entitlement、GA ceremony、release-evidence registry、bridge cohort/readiness、path/dbKey rebind、双 locator 与未注册 bundle import。这些机制能形成闭环，但超过当前 L1 的产品范围和项目基础设施，也使完成定义依赖尚不存在的离线签名体系。

本版删除上述机制，恢复以下权威关系：

- L1 只解决“当前注册路径上的项目数据库如何安全、快速地保存与恢复”；
- 数据目录迁移边界和未注册备份导入继续按上游范围第 9 节推迟到 V1 之后；
- Task 8 的实现与本地验收必须先于 native 工程和生产接入完成；实际 installer、tag、release 是完整 L1 候选成熟后的独立授权动作，不阻塞 Stage B/C；
- native 降级写屏障由 schema 11 与数据库 trigger 提供，不要求用户安装过中间 bridge；
- native 激活安全由编译期模式和隔离 fixture marker 提供，不引入运行时签名授权；
- ControlStore checkpoint 只压缩事件历史，不再承担整库字节备份证明；
- graceful shutdown 不计算整库 SHA-256，也不强制创建 checkpoint。

第 7 版进一步移除“先发布兼容版本才能进入 Stage B/C”的实施耦合，并为 Stage B
direct fixture 增加只能存在于测试 module graph 的 genesis basis；installer、tag、release
继续作为完整 L1 候选成熟后的独立授权动作。

第 8 版冻结 native cold recovery facade：未终结 source/prepared 在接触 SQLite 前保持
`recovery_required`，source cleanup 始终由调用者负责；同时固定 recover 返回联合、
connection epoch 生命周期、hot-journal 前检查顺序和 same-path replacement 错误映射。

若本文与原计划在 native 项目存储、checkpoint、激活、identity adoption、桌面单实例和 shutdown 上冲突，以本文为准。其余 L1 约束仍以上游范围和计划为准。

## 2. 新审查意见的取舍

| 审查意见 | 结论 | 本版处理 |
|---|---|---|
| 文档规模已经反过来阻碍实现 | 成立 | 删除只为发布仪式和跨路径迁移服务的章节，把完成条件收回到仓库能够实现的能力 |
| 签名 entitlement、QA result、GA ceremony 形成防御性递归 | 成立 | 改为三个编译期 activation mode；测试专用构建只接受隔离 marker，正式构建走普通发布流程 |
| path/dbKey rebind 与 data-root 迁移违反上游范围 | 成立 | 完整移出 L1；native 项目存在时，现有 data-dir 迁移命令必须零修改拒绝 |
| bridge readiness 会使跳版本用户永久停留在 v1 | 成立 | 删除 bridge、cohort 和逐项目 readiness；任何 clean schema 10 项目都可由 native 版本直接升级 |
| schema 11 trigger 已足以阻止旧业务 DML | 成立 | trigger 是旧版本写屏障；旧版本可读体验不作保证，但业务写必须原子失败 |
| 退出时整库 hash 导致慢退出和确认分支 | 成立 | hash 移出 shutdown；checkpoint 也改为运行期 maintenance |
| seq、项目实例和 integrity check 等于字节相同 | 不完全成立 | 它们只证明协议一致性，不证明字节完全相同；identity adoption 必须由用户明确确认，文档不得再声称 exact-byte equivalence |

被删除的机制不得以其他名称重新引入本轮实施：

- ActivationEntitlement 及 production/QA 判别分支；
- phase-g-result-attestation、GA ceremony attestation；
- sqlite-release-evidence registry；
- ExpiredQaTransitionRecoveryAuthorization；
- nativeCompatibilityManifest 的签名授权用途；
- bridge release、cohort manifest、sqlite.bridge.fence_ready；
- sqlite.project.path_rebind、live data-root migration；
- clean bundle restore、双 locator 与未注册 bundle import。

## 3. 已确认的设计决策

### D1｜只迁移项目数据库

projects 目录下的项目数据库迁移到 Bun 内置 bun:sqlite。

config.db 继续使用现有 sql.js 与 SqlJsAtomicStore。本轮不同时重写配置库、CLI 最近项目索引或配置 schema。

所有可能以可写方式打开同一 config.db 的 server、sidecar 和 CLI 必须先取得 ConfigLifecycleLease，并从打开前一直持有到 store、connection 和底层 guard 都完成关闭。

### D2｜使用 DELETE journal，并按真实平台能力启用

项目数据库固定配置：

- journal_mode = DELETE；
- synchronous = EXTRA；
- foreign_keys = ON；
- busy_timeout = 100 ms。

首版不采用 WAL，避免把 wal/shm 文件引入复制、删除、诊断和身份边界。

Windows 内置 SQLite VFS 不因 EXTRA 名称自动获得 journal unlink 目录同步保证。PRAGMA 回读和目录 HANDLE flush 都只能是证据的一部分，不能单独把能力设为 true。

生产 native 写入要求两个独立能力同时成立：

1. nativeRollbackJournalDurability：证明 DB 与 rollback journal 的提交恢复；
2. nativeApplicationDirectoryEntryDurability：证明 ControlStore event、tail、checkpoint 和 activation 目录项的安装。

任一能力不成立时，项目保持 v1 或进入可诊断的 unsupported 状态，不得写 native backend marker。

### D3｜SQLite 负责事务，ControlStore 负责跨层证明

SQLite rollback journal 保证单个数据库事务在恢复后是 before 或 after。

ControlStore 记录 source、prepared、committed、rolled_back、activation 和 identity adoption 证据。数据库内 durability_commit_seq 消除“SQLite 已提交、ControlStore terminal 尚未写入”的窗口。

ControlStore 不保存项目正文、SQL、参数或数据库字节。

### D4｜schema 11 trigger 是唯一降级写屏障

native 激活把 PROJECT_SCHEMA_VERSION 从 10 提升到 11，并在同一 SQLite 事务中安装：

- _durability_write_gate；
- 覆盖所有应用可写业务表的 canonical downgrade triggers；
- durability_backend = native-sqlite-v2；
- durability_commit_seq = 0。

schema 11 只增加耐久层内部表、trigger 和版本边界，不改变 REST 业务语义、正文模型或领域字段；这是对原计划“不改业务 schema”的窄化说明。

NativeProjectStore 每次业务事务在同一个外层事务内临时打开 gate、执行业务写与 seq CAS、再清空 gate。事务外 gate 必须为空。

facade runtime authorization 禁止普通 projectExecute、ManuscriptService 业务 SQL、AI 工具或业务 migration 直接插入、更新、删除两个 trigger 保留键、_durability_write_gate 或 canonical trigger DDL；只有持有内部耐久 capability 的 generator/migration 精确语句可以修改。

全部 downgrade trigger 名称、目标表、操作类型和 SQL 只能由一个 canonical trigger generator 产生。generator 输出按 trigger name 的 UTF-8 字节序稳定排序，SQL 以固定 tokenizer 规范化行尾、空白和关键字后形成 canonical JSON，再计算 SHA-256 triggerSetDigest。每次项目 open、事务 preflight、COMMIT 后验证和 identity adoption 都必须做三方比对：

1. 当前代码 generator 得到的 expected digest；
2. project_meta.durability_trigger_set_digest；
3. 从 sqlite_schema 实际 trigger name、tbl_name 和 SQL 重新规范化得到的 observed digest。

只检查 trigger 名称、数量或 durability_trigger_version 不足以通过。schema migration 新增可写业务表时，必须在同一个 migration 事务中把该表登记进 generator、安装 INSERT/UPDATE/DELETE 屏障并更新 version/digest。schema audit 还必须枚举全部非 SQLite 内部表：任何不在 generator writable set 或显式 internal/read-only allowlist 的表都使 migration 测试失败，避免“新表根本没有登记”绕过 digest。

v0.0.9 及更早版本不理解 native ControlStore evidence，但其普通 INSERT、UPDATE、DELETE 会被 schema 11 trigger 拒绝。测试必须证明拒绝后数据库文件字节和 ControlStore 都不变。

任何 open、migration、recovery 或 DML 在接触项目写路径前都必须拒绝高于当前 PROJECT_SCHEMA_VERSION 的 schema，返回 PROJECT_SCHEMA_TOO_NEW；不得尝试降级、修 trigger 或把高版本文件误判为普通损坏。

旧版本如果能任意修改 schema、删除 trigger 或直接操作文件，不在本轮威胁模型内。

### D5｜激活采用编译期模式，不采用签名授权

编译期常量 NATIVE_ACTIVATION_MODE 只有三个值：

| 模式 | 用途 | 允许的行为 |
|---|---|---|
| off | 默认开发、兼容版发布和普通 CI | production activation coordinator 不进入构建，只链接返回 NATIVE_ACTIVATION_DISABLED 的 stub |
| fixture_only | 专用集成/崩溃测试二进制，不打包发布 | 只允许全新临时 data root，且要求 harness 预置一次性 fixture marker |
| production | 正式 native release 构建 | 允许对当前注册、通过完整 preflight 的 clean v1 项目激活 |

不能用环境变量、HTTP 参数、隐藏 CLI 开关或 marker 把 off 构建切换成 production。

fixture_only 的 marker 只是一道防误用边界，不是安全凭证。测试根必须是 harness 新建的临时目录，不得是默认用户 data root、现有配置注册根或其复制品。fixture 二进制不得进入 installer。

marker 由 harness 在创建任何 fixture 项目前用 no-clobber 方式写入，绑定随机 runId、canonical root digest 和 expiresAt。activation.prepared 保存 marker digest；同一根出现过任一 activation event 后，该 marker 不得再次授权新的 activation。

production 构建按项目现有签名、测试、打包和发布流程验收，不新增离线私钥、HSM 或 runtime entitlement。

sidecar 必须在 owned-child ready frame 和 nonce 认证的 build.info 控制响应中报告编译期 nativeActivationMode、完整 source commit 和 target triple。该值来自编译常量，不读取环境变量、CLI 或配置。兼容版、fixture 和 production 的打包/smoke job 分别断言 off、fixture_only、production；fixture_only 产物进入 installer 或 production 报告为非 production 时，打包必须失败。

### D6｜Task 8 本地验收先完成；发布不阻塞 Stage B/C

Task 8、D9、D10 的实现与本地编译产物验收是 native 工程的前置。该前置已经由
Stage A acceptance 账本闭环。Stage B 的 direct fixture store 和 Stage C 的隔离
fixture 验证不要求用户安装过兼容版本，也不要求先执行 installer、tag 或 release。

Stage A 的 native activation = off 兼容基础包含：

- Task 8 诊断、恢复、导出和项目隔离；
- ConfigLifecycleLease；
- v1 terminal 双重验证；
- SQL guard fail-closed；
- production JSON error middleware；
- D9 单实例；
- D10 可确认 shutdown。

用户可以跳过该版本直接安装未来 native 版本。它不是激活 bridge，也不产生 readiness。

### D7｜identity adoption 不依赖退出时整库 hash

native 正常事务 terminal 只保存 finalSeq、projectInstanceId、schema/backend、文件 identity 和事件 digest，不保存整库 SHA-256。

同一 canonical path 出现新物理 identity 时，普通 open 必须 fail-closed。Task 8 可以在用户明确确认后执行 same-path identity adoption，但必须清楚表述：

- 系统证明的是“候选数据库符合最后一个协议 generation 且内部一致”；
- 系统不再证明“候选数据库与原文件逐字节相同”；
- 任意能离线修改 SQLite 内容并保留 seq/实例的本地进程不在 L1 威胁模型内。

### D8｜单项目故障不得阻塞健康项目

ConfigLifecycleLease、config.db、data root 基础安全或服务初始化失败仍拒绝启动。

单个项目的 RECOVERY_REQUIRED、identity mismatch、native capability 不足或数据库损坏只隔离该项目。服务继续监听，健康项目继续可用。

### D9｜桌面单实例与 sidecar 所有权属于存储边界

Tauri 必须在 spawn sidecar 前取得单实例所有权。第二次启动只聚焦已有窗口，不创建 sidecar、不探测端口、不接触 config。

每个主实例生成随机 256-bit nonce，sidecar 绑定 loopback 动态端口。Tauri 保留 child stdout、stderr、terminated 事件流，并通过内存 IPC 向自己的 renderer 提供 port、nonce 和 owned child handle。

renderer 不得写死 127.0.0.1:3001。业务请求必须携带实例 nonce。shutdown 只走 owned child stdin/stdout 控制通道，不提供普通 HTTP 关闭端点。

ConfigLifecycleLease 仍负责 CLI、直接 sidecar、开发服务和异常桌面启动之间的最终互斥。

### D10｜graceful shutdown 只等待真实资源终态

正常桌面退出必须：

1. 停止接受新的 mutation；
2. 等待队列中的写事务得到 committed 或 rolled_back；
3. 终结已落盘但尚无 terminal 的协议；
4. 关闭所有项目 connection；
5. 关闭 config store；
6. 释放可以证明由本进程持有的 guard 与 lease；
7. 返回 shutdown.complete 后等待 child 正常退出。

shutdown 不做整库 SHA-256，不强制创建 ControlStore checkpoint，也没有 shutdown.needs_confirmation 或 restoreBasisCreated 分支。

软 deadline 只能提示“继续等待、取消退出、紧急退出”，不得自动 kill。用户选择紧急退出或操作系统强杀时按普通 crash 处理，不能记录为 graceful。

## 4. 非目标与范围边界

本轮不做：

- config.db 的 bun:sqlite 重写；
- WAL；
- Git 权威层、文件权威层或 AI 侧耐久化；
- 数据根迁移协议、path/dbKey rebind；
- 未注册项目 bundle 导入或归档恢复；
- 让旧版本继续编辑 schema 11 项目；
- 防御能任意改 schema、删除 trigger 或直接覆盖数据库的恶意本地程序；
- macOS 未验证能力的猜测性实现；
- 为了“测试与 GA 同一字节”引入签名授权或发布仪式。

现有 data-dir 命令边界：

- 纯 v1 根继续沿用当前已经发布的迁移行为和现有测试；
- 当前根存在任何 native v2 项目时，data-dir set 和 migrate 都必须在修改 config、创建目标目录或复制字节前返回 NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED；
- UI/CLI 明确说明“native 项目迁移将在 V1 之后单独设计”；
- L1 不以删除或破坏已有 v1 迁移能力换取简化。

## 5. 当前问题与目标

当前项目保存使用 sql.js 内存数据库。一次小修改也会导出完整数据库、写候选、fsync、重开校验、保存 before、替换并再次验证。

3,000 章参考项目约 35.52 MiB，已记录结果：

| 场景 | 目标 | 当前 p95 | 状态 |
|---|---:|---:|---|
| 项目保存端到端 | < 300 ms | 1533.30 ms | FAIL |
| 整库候选发布 | < 500 ms | 1642.90 ms | FAIL |
| 原生 SQLite 单行探针 | 参考值 | 约 9.64 ms | 不含完整协议成本 |

收尾目标：

- 项目写入不再导出整库；
- native 耐久事务 p95 < 500 ms；
- 项目保存端到端 p95 < 300 ms；
- ControlStore append 成本不随全部历史线性增长；
- 任何崩溃点唯一收敛到 before 或 after；
- 用户命中不可自动恢复状态时有可操作出口；
- 退出不因整库 hash 或 checkpoint 产生常态长等待。

## 6. 目标架构

### 6.1 组件边界

NativeProjectStore 负责：

- bun:sqlite connection 生命周期；
- DELETE/EXTRA/foreign_keys/busy_timeout；
- 外层事务；
- durability_commit_seq；
- gate 与 downgrade triggers；
- connection epoch；
- DatabaseIdentityGuard。

NativeProjectStore factory 先只解析 admission、ControlStore exact tail 与只读文件 identity。
clean basis 才直接打开为 `active` 并生成一个历史未使用的 UUID connection epoch；source-only
或 prepared suffix 返回尚无 SQLite connection 的 cold recovery facade，其公开
`state='recovery_required'`、`connectionEpoch=null`。cold facade 只允许 `recover()`、
`close()`、`fence()` 与只读 getters；read、write 和 checkpoint 都以
`RECOVERY_REQUIRED` 零 SQLite、零 ControlStore 副作用拒绝。

ControlStore 负责：

- 只追加事件；
- tail 与 successor 唯一性；
- checkpoint 与有界活动后缀；
- 未终结事务、activation 和 adoption 的恢复证据。

ProjectWriteCoordinator 负责：

- 跨进程 writer lease；
- 进程内 FIFO；
- 每个队列项进入业务回调前先恢复；
- lease loss 后拒绝当前项和后续项。

ManuscriptService 继续是 chapters.content 的唯一业务写入口。

RecoveryDiagnostics 只读分析现场，并在显式 POST 中调用既有恢复器或新协议动作；路由层不复制恢复算法。

### 6.2 前置基础不变量

native facade 接入生产写路径之前，以下项目必须先通过：

1. ConfigLifecycleLease 覆盖 config open、recover、write、close 全生命周期；
2. v1 recovery 在 terminal 前后验证同一最终 predicate；
3. v1 close 和 lease release 失败先 logical fence，再报告 disposition；
4. row-value UPDATE、plain INSERT 等 SQL guard 盲区 fail-closed；
5. 静态 SQL 扫描独立于运行时 classifier；
6. production API 始终返回 JSON error envelope；
7. token_usage 写失败不改变 AI 主流程；
8. D9 与 D10 通过桌面编译产物测试。

## 7. Native v2 磁盘协议

### 7.1 project_meta 保留键

| key | 语义 |
|---|---|
| project_instance_id | 项目逻辑实例 UUID，创建后不可复用 |
| durability_backend | sqljs-v1 或 native-sqlite-v2 |
| durability_commit_seq | native 已提交事务序号，从 0 开始 |
| durability_trigger_version | canonical trigger generator 的 migration 版本 |
| durability_trigger_set_digest | canonical trigger set 的 SHA-256 |

两个 trigger 键必须同时存在；version 用于 migration 记账，digest 用于实际完整性证明。任一保留键缺失、重复、格式非法，digest 三方不一致或与 ControlStore 不一致时返回 RECOVERY_REQUIRED。

### 7.2 事件公共字段

所有新事件至少包含：

- version；
- eventId；
- dbKey；
- projectInstanceIdSha256；
- createdAt；
- prevDigest；
- eventDigest；
- ownershipHash；
- connectionEpoch。

dbKey 继续由当前 canonical project path 派生。本轮不允许改变 path/dbKey。

历史 event 的 dbKey、projectInstanceIdSha256 与 ownershipHash 必须始终绑定 immutable
genesis；已终结历史可以保留旧 connectionEpoch。一次普通 transaction attempt 的
source、prepared 与直接 terminal 共享 source epoch，且只有当前待消费 source 必须等于
当前 connection epoch。跨进程 recovery 可以由新 recovery epoch 以
`recovery_before_commit` rolled_back 或 recovered committed 终结旧 prepared，但必须由
恢复状态机证明；普通 transaction 不能借此产生跨 epoch terminal，也不能把全部历史 epoch
粗暴改写为当前值。

connection epoch 生命周期固定如下：clean factory 直接生成新 epoch；cold facade 的 epoch
为 null；source-only cleanup 事件继续使用原 source 的 connectionEpoch；prepared recovery
只有在 SQLite recovery 与全部 live predicates 通过后才生成一个在完整历史中未使用的新
epoch，并由该 epoch 写 recovery terminal。clean facade 上调用 `recover()` 是幂等操作，
不得轮换 epoch。

### 7.3 manuscript.source 与 abandoned

ManuscriptService 在产生外部可见写副作用前追加 manuscript.source。事件只保存 logicalRequestDigest、attemptSeq、ownership、目标实体和 expected_data_version，不保存正文。sourceDigest 是该 source event 自身的 digest，不是正文 hash。

如果 validation、CAS 或主动取消发生在 prepared 前，追加 manuscript.source.abandoned。
该事件永远由拥有 source 语义的调用者追加：Stage B crash harness 负责 fixture，未来由
ManuscriptService 负责 production。NativeProjectStore 和 cold recovery facade 都不得代写
abandoned。

同一个 sourceDigest 只能被一个 prepared 或一个 abandoned 消费。有界自动重试沿用 logicalRequestDigest，但 attemptSeq 递增并产生新的 source event/sourceDigest，同时引用 previousAttemptSourceDigest；因此 busy 重试不会让一个 source 被两个 prepared 消费。

source-only cold facade 的 `recover()` 只做 exact tail/identity/lease 只读复核，返回
`{status:'source_pending',sourceDigest,finalSeq,connectionEpoch:null}`，不得打开 SQLite 或
追加事件。调用者必须以原 source connectionEpoch 和当前 source digest 为 CAS tail，追加
reasonCode 为 `superseded` 或 `cancelled` 的 exact abandoned；同一个 cold facade 只接受这
一个 exact successor。随后再次 `recover()` 才可从头验证、生成历史未使用的新 epoch 并
打开为 active。错误类型、错误 epoch、错误 sourceDigest、额外 successor 或 tail 变化都
fail-closed。

### 7.4 sqlite.tx.prepared

prepared 绑定：

- transactionId；
- sourceDigest；
- beforeSeq；
- expectedFinalSeq = beforeSeq + 1；
- schemaVersion = 11；
- backend = native-sqlite-v2；
- expectedTriggerVersion；
- expectedTriggerSetDigest；
- expected identity；
- operationKind。

prepared 必须在 SQLite BEGIN IMMEDIATE 之前完成 durable append 与 post-check。

### 7.5 sqlite.tx.committed

committed 绑定：

- preparedDigest；
- finalSeq；
- schema/backend；
- gate 为空；
- canonical trigger version 与 triggerSetDigest；
- post-commit identity。

普通提交不计算整库 hash。

### 7.6 sqlite.tx.rolled_back

rolled_back 绑定 preparedDigest、beforeSeq、reasonCode、rollbackKind 和对应终结 predicate。rollbackKind 只有：

- begin_not_acquired：BEGIN IMMEDIATE 返回 BUSY/LOCKED，SQLite autocommit 仍为 true，当前尝试从未取得写锁、未执行 gate/DML/seq SQL，也不得调用 ROLLBACK；
- transaction_rolled_back：事务已经开始，ROLLBACK 成功，且 seq、gate、trigger version/digest、identity 均等于事务开始后冻结的 pre-write snapshot。
- recovery_before_commit：新进程恢复 prepared 时，SQLite/hot-journal recovery 完成后 seq 仍为 beforeSeq，gate 为空，trigger version/digest、identity 与 prepared 一致，证明没有 committed after-state。

connection disposition 不明、autocommit 状态不符或无法证明当前尝试没有留下写入时，不追加 rolled_back。

### 7.7 Stage B fixture genesis

Stage B 的 direct fixture 在完成 schema 11 原子安装后，必须向空 ControlStore 追加并
post-check 一条 `sqlite.native.stage_b.fixture_genesis`，精确绑定 dbKey、project
instance、ownership、creation epoch、schema/backend、seq 0、空 gate、trigger
version/digest 和最终 identity。它是 direct fixture 的 clean basis，不是 activation 或
production creation evidence。

普通 NativeProjectStore 对空 ControlStore 和 fixture genesis 一律拒绝。只有不进入
production module graph 的 testing factory 能以 closure-private verifier 接受该事件；
普通 sidecar 的构建合同必须证明 testing factory、fixture event type 和 authority 不在
编译产物中。Stage C 必须使用 activation/creation 的正式 verifier，禁止复用 fixture
genesis 作为 production 旁路。

testing factory 的 genesis database SHA-256 只用于 suffix 为空时的首次 direct-fixture
打开。合法 native suffix 出现后，clean reopen 必须由第一条 exact genesis、完整 suffix
状态机与当前 DB predicates 共同证明；不得继续要求数据库字节等于 genesis 初始 hash，
也不得借此接受未知 suffix 或导出 fixture authority。

### 7.8 activation 事件

激活使用三个事件：

- sqlite.native.activation.prepared；
- sqlite.native.activation.activated；
- sqlite.native.activation.aborted。

prepared 绑定 activationId、clean v1 terminal digest、v1 formal SHA-256、v1 identity、project instance、目标 schema、trigger version/triggerSetDigest、backend 和编译期 activation mode。

这里保留 v1 formal hash，因为 sql.js publication 本来就生成完整候选字节，而且激活是一次性低频操作。它不等于要求 native 每次退出计算 hash。

activated 绑定 preparedDigest、schema 11、backend、seq 0、gate 为空、trigger version/triggerSetDigest 和最终 identity。

aborted 只允许在数据库仍是完整 schema 10、没有任何 native marker/trigger/gate、v1 recovery 已 clean 且完整 hash 已重新计算时追加。

### 7.9 identity adoption 事件

sqlite.identity.adopted 绑定：

- 旧 identity 与新 identity；
- canonical path digest 与 dbKey；
- basis terminal/checkpoint digest；
- finalSeq；
- projectInstanceIdSha256；
- schema/backend/trigger version/triggerSetDigest；
- integrity/FK 结果；
- userConfirmationId。

它不包含“字节相同”声明，也不能终结 transaction 或 activation prepared。

## 8. ControlStore checkpoint

checkpoint 只用于压缩 ControlStore 历史。

### 8.1 模式、分类与读取接口

`openControlStore(controlDir)` 严格等价于 exact
`openControlStore(controlDir, {bounded:false})`。pure-v1 的 public facade、错误、返回值和
目录全部字节保持不变；只有 exact `{bounded:true}` 才允许创建或更新 tail/checkpoint。

对已存在目录，分类必须早于 `mkdir`、active-record write/fsync、temp cleanup 和 legacy
event replay。没有 tail/checkpoint final 或 candidate metadata 才是 pure-v1；任一此类
metadata 存在即为 bounded-v2 candidate。read-only inspector 自动验证两类且零写；默认
writer 遇 bounded-v2 固定 `CONTROL_STORE_PROTOCOL_UNSUPPORTED` 且零写，绝不能在已 GC 的
目录中从 seq 1 重放；exact-name tail/checkpoint candidate 也触发这个默认-writer 拒绝。
bounded writer/inspector 只接受冻结 epoch 2；otherwise-exact 的更高 protocol epoch 返回
`CONTROL_STORE_PROTOCOL_UNSUPPORTED`，低于 2、修改 epoch-2 固定参数、metadata exact
schema/digest 错误、tail 引用 event 缺失和 referenced checkpoint missing/corrupt 都是
`CONTROL_STORE_CORRUPT`。

bounded facade 的接口固定为：

- `read()`：只返回 checkpoint 后的 active absolute suffix；
- `tail()`：完全空 evidence 返回 `null`，否则返回 exact frozen `{seq,digest}` reference；
- `readEvidence()`：返回 exact frozen `{checkpoint,events,tail}`，其中 checkpoint 是完整已验
  checkpoint 或 `null`，events 与 `read()` 相同，tail 是完整 persistent tail record。
- `retire()` / `retireAndActivate()`：保留两个方法名以维持 facade shape，但 bounded facade
  从 tail-only evidence 起始终同步返回 `CONTROL_STORE_PROTOCOL_UNSUPPORTED`。拒绝必须早于
  lease、filesystem read/write、legacy replay、cleanup 和 validator callback；validator 零
  调用，目录树与 lifecycle/active metadata 逐字节不变。pure-v1/default facade 的既有行为
  不变；checkpoint-aware retirement/activation 延后到后续显式合同，不由 Task 5–7 实现。

`inspectControlStoreEvidence()` outer exact `{events,projection}` 不变；projection 仍为 exact
`{incarnationId,tail,checkpoint,events}`。bounded outer events 只含 active suffix；projection
tail 是同一个 `null|{seq,digest}` reference，events 只含
`{seq,type,digest,prevDigest}`，checkpoint 只投影 exact summary：

```json
{
  "checkpointDigest": "<64 lowercase hex>",
  "coveredSeq": 12345,
  "coveredDigest": "<64 lowercase hex>",
  "chainRoot": {"seq": 1, "digest": "<64 lowercase hex>"},
  "latestCleanBasisDigest": "<64 lowercase hex>"
}
```

没有 checkpoint 时 projection checkpoint 为 `null`。identity、Bloom bytes、
`previousCheckpoint` lineage descriptor 和 raw payload 不得进入 projection；完整 internal
`readEvidence()` checkpoint object 仍包含并验证该 digest-covered descriptor。

### 8.2 创建条件与 exact checkpoint

只有以下条件全部成立才可创建：

- 没有未终结 source、transaction、activation 或 adoption；
- 当前 tail 唯一且完整；
- 数据库 schema/backend/seq/instance/identity 与最新 terminal 一致；
- writer lease 与 identity guard 持续有效；
- checkpoint 覆盖到当前精确 tail。
- outer logical request 的 closure-private writer turn 已覆盖全部 bounded retry 尝试和最终决策
  并关闭，checkpoint writer 持有该 turn 发出的 non-serializable capability；不得信任 caller
  提供的 `retryContinuationOpen` raw boolean。

checkpoint final 名称固定为
`.controlstore-checkpoint-<coveredSeq>-<checkpointDigest>.json`；`checkpointDigest` 是去掉
自身字段后 exact object 的 canonical JSON SHA-256。schema 固定为：

checkpoint candidate 名称固定为
`.controlstore-checkpoint-<coveredSeq>-<uuid-v4>.tmp`，其内容就是将发布 final 的 exact
canonical checkpoint bytes，不允许 wrapper/额外 key。tail candidate 名称固定为
`.controlstore-tail-<uuid-v4>.tmp`，内容就是将 replace 的 exact canonical tail bytes。

```json
{
  "version": 1,
  "checkpointDigest": "<64 lowercase hex>",
  "controlProtocolEpoch": 2,
  "incarnationId": "<uuid-v4>",
  "admissionBasis": {
    "basisKind": "stage_b_fixture_genesis",
    "basisDigest": "<64 lowercase hex>",
    "admissionEvent": {
      "seq": 1,
      "type": "sqlite.native.stage_b.fixture_genesis",
      "payload": {
        "version": 1,
        "eventId": "<uuid-v4>",
        "dbKey": "<64 lowercase hex>",
        "projectInstanceIdSha256": "<64 lowercase hex>",
        "createdAt": "<YYYY-MM-DDTHH:mm:ss.sssZ>",
        "ownershipHash": "<64 lowercase hex>",
        "connectionEpoch": "<uuid-v4>",
        "fixtureRunId": "<uuid-v4>",
        "schemaVersion": 11,
        "backend": "native-sqlite-v2",
        "finalSeq": 0,
        "gateEmpty": true,
        "triggerVersion": 1,
        "triggerSetDigest": "<64 lowercase hex>",
        "identity": {"dev": "<decimal string>", "ino": "<decimal string>"}
      },
      "prevDigest": null,
      "digest": "<same 64 lowercase hex as basisDigest and chainRoot.digest>"
    }
  },
  "coveredSeq": 12345,
  "coveredDigest": "<64 lowercase hex>",
  "chainRoot": {"seq": 1, "digest": "<64 lowercase hex>"},
  "previousCheckpoint": {
    "checkpointFile": ".controlstore-checkpoint-4096-<old checkpoint digest>.json",
    "checkpointDigest": "<old checkpoint digest>",
    "coveredSeq": 4096,
    "coveredDigest": "<old covered event digest>"
  },
  "dbKey": "<64 lowercase hex>",
  "schema": 11,
  "backend": "native-sqlite-v2",
  "finalSeq": 321,
  "triggerVersion": 1,
  "triggerSetDigest": "<64 lowercase hex>",
  "projectInstanceIdSha256": "<64 lowercase hex>",
  "identity": {"dev": "<decimal string>", "ino": "<decimal string>"},
  "latestCleanBasisDigest": "<64 lowercase hex>",
  "eventTypeCounts": {"sqlite.tx.committed": 1},
  "unresolved": [],
  "retryContinuationOpen": false,
  "connectionEpochFilter": {
    "algorithm": "sha256-domain-separated-v1",
    "bitCount": 8388608,
    "hashCount": 7,
    "bitsBase64": "<canonical base64 of exactly 1048576 bytes>",
    "epochObservationCount": 12345
  }
}
```

checkpoint top-level logical key order 冻结为
`version,checkpointDigest,controlProtocolEpoch,incarnationId,admissionBasis,coveredSeq,
coveredDigest,chainRoot,previousCheckpoint,dbKey,schema,backend,finalSeq,triggerVersion,
triggerSetDigest,projectInstanceIdSha256,identity,latestCleanBasisDigest,eventTypeCounts,
unresolved,retryContinuationOpen,connectionEpochFilter`；`previousCheckpoint` 只允许 `null` 或
exact data object，其 nested logical key order 冻结为
`checkpointFile,checkpointDigest,coveredSeq,coveredDigest`。canonical JSON 仍按既有规则排序；
去掉 top-level `checkpointDigest` 后计算的 digest 覆盖整个 `previousCheckpoint`。

安装前 old persistent tail 没有 checkpoint 时，首次 checkpoint 的 `previousCheckpoint` 必须
exact `null`；old persistent tail 已引用 checkpoint 时，真正安装的 repeated checkpoint 必须把
该 tail reference 的 `checkpointFile/checkpointDigest/coveredSeq/coveredDigest` 逐项复制，且
current `coveredSeq > previousCheckpoint.coveredSeq`。Task 5 parser 在 Task 6 schema amendment 中
只机械验证 null-or-exact shape、positive safe-integer `coveredSeq`、两个 digest 都是 64
lowercase hex、basename exact
`.controlstore-checkpoint-<coveredSeq>-<checkpointDigest>.json` 与 seq 严格关系；
不得因为 descriptor 指向的 old final 已不存在而拒绝 current checkpoint。首次/null 与
repeated/inherited 的 authority 证明属于 Task 6 installer。

首次 checkpoint 必须保存已经外部 authority 认证的 exact canonical seq-1 admission event
deep copy；parser 重算 event digest 并要求它等于 `basisDigest=chainRoot.digest`、
`chainRoot.seq=1`。fixture verifier 仍用 descriptor `genesisDigest/fixtureRunId`；checkpoint
不能自证。这个 epoch-2 Stage B schema 只允许 exact fixture genesis；production activation
前必须另行冻结 production basis 的 exact tagged union 与显式 migration，不能把 hardcoded
fixture schema 解释成 production authority。后续 checkpoint 逐字继承整个
`admissionBasis`。chain root、latest clean basis、各事件类型计数和 epoch filter 都是截至
`coveredSeq` 的累计证明，并在 repeated checkpoint 中精确继承。`unresolved` 必须 exact
`[]`，`retryContinuationOpen` 必须 exact `false`。checkpoint 不保存 `formalSha256`、正文、
SQL、参数或数据库 bytes，不承担项目备份或 identity adoption 的字节证明。

### 8.3 connection epoch filter 与 retry 边界

filter 固定为 1 MiB（1,048,576 bytes）、8,388,608 bits、7 hashes；`bitsBase64` 必须是
RFC 4648 canonical base64，解码长度 exact 1,048,576，重新编码逐字节相同。algorithm 固定
`sha256-domain-separated-v1`。插入和查询前必须验证 UUID-v4 并规范化为 lowercase canonical
ASCII，active used-epoch set 使用同一规范化，禁止 raw 大小写造成 false negative。令 domain
为 UTF-8 bytes `mythpen-controlstore-connection-epoch-v1\0`，`basisRaw` 为
`admissionBasis.basisDigest` 的 32 raw bytes；每个 `i=0..6` 计算
`SHA-256(domain || one-byte(i) || basisRaw || normalizedEpochAscii)`，取 digest 前 23 bits 的
big-endian unsigned value 为 index；若 digest bytes 为 `d`，精确公式为
`(((d[0]<<16)|(d[1]<<8)|d[2]) >>> 1)`。byte 内 bit numbering 为 least-significant-bit first。

只有经过 native exact parser 且其冻结 event schema 明确拥有
`payload.connectionEpoch` 的 covered event 才能贡献 observation；legacy/generic payload 中
偶然同名字段绝不进入 filter。每个合格 event 设置七个位并让
`epochObservationCount += 1`；重复 observation 也计数。没有 previous checkpoint 时，首次
checkpoint 在 GC 前从全部 covered events 构造；后续 checkpoint 必须从 previous exact bits
开始，只 OR 本次新覆盖 absolute suffix `(oldCoveredSeq,newCoveredSeq]`，并设置
`epochObservationCount=previousCount+newSuffixObservations`。禁止从剩余 active suffix 重建、
清 bit 或改变 epoch-2 参数/编码，因此不得产生 false negative。checkpointDigest 覆盖 filter；
tail 的 checkpointFile/checkpointDigest 引用它，tail recordDigest 覆盖引用，不接受 detached
filter。

epoch-2 actual popcount 硬不变量为 `<=4,194,304`（50%）。发布 checkpoint final、tail commit
或 GC 前必须计算 inherited-OR candidate；超过阈值返回 `CONTROL_CHECKPOINT_BLOCKED`、保留
旧 checkpoint/tail/events、零 GC，等待新 protocol 扩容。已持久化 epoch-2 filter 超阈值是
`CONTROL_STORE_CORRUPT`。algorithm/bitCount/hashCount/encoding/阈值改变必须提升 protocol
epoch 并提供显式迁移。50% 时单次 false-positive `<=2^-7`、128 个独立随机 UUID 全耗尽
`<=2^-896` 只是 random-oracle/独立 UUID 下的可用性估计；安全性来自 false positive 只拒绝，
连续 128 次命中后 fail-closed `RECOVERY_REQUIRED`。Task 7 还必须证明 fresh epoch 不在 active
suffix exact used set 中。

Task 6 的 internal controller seam 固定为 module-private
`WeakMap<boundedFacade,checkpointController>`；controller 不得挂在 facade 的 string/symbol/
non-enumerable property 上，ordinary facade 的 `Reflect.ownKeys()` 与三个 enumerable module
exports 保持 Task 5 exact。`control-store.js` 只增加下面这个 property：

```js
Object.defineProperty(module.exports, 'getBoundedControlStoreCheckpointController', {
  value: getBoundedControlStoreCheckpointController,
  enumerable: false,
  writable: false,
  configurable: false,
});
```

getter 只接受同一 loaded module 实际 mint 的 bounded facade identity；default facade、duck
object、另一个 loaded module instance 的 facade 或伪造对象都在 filesystem/lease/provider 前
零写 `CONTROL_STORE_PROTOCOL_UNSUPPORTED`。同一 facade 每次取得同一 exact frozen
`{installCheckpoint,maintenanceStatus}` controller。non-enumerable 只是 API hygiene，不是安全
边界：Task 6 除测试本身外，只有 `server/testing/bounded-control-store.js` 可读取/调用 getter；
Task 7 才允许 `server/native/native-project-store.js` 成为第二个 runtime caller，并须加 import/
build graph 负控。`server/testing/native-stage-b-store.js` 只构造并传递 bounded facade，不读取
getter；native/coordinator/production module 永不 import testing harness。

`server/testing/bounded-control-store.js` 的 enumerable export 只有
`createBoundedControlStoreTestHarness(controlDir, authoritySource)`。返回 exact frozen
`{controlStore,checkpoint,maintenanceStatus}`；zero-argument `checkpoint()` 通过 closure-retained
controller 和 module-minted zero-argument provider 同步读取 synthetic/already-verified test
authority。`authoritySource` 必须是 exact test-only zero-argument synchronous function
（`typeof==='function'`、`length===0`）；每个到达 provider evaluation 的 `checkpoint()` 只在
dual-lease turn 内调用它一次，绝不提前/重复调用。throw 或 promise/thenable result 按 provider
failure 处理。`maintenanceStatus()` 只代理 controller。controller/getter/provider 都不得从 harness
返回、挂到 `controlStore` 或进入 ordinary facade。这个 harness 只证明机械合同，不能证明
native provenance。

checkpoint startup reconcile 固定属于 bounded `openControlStore()` bootstrap。它必须在 facade
构造与 WeakMap/controller 注册前先取得 outer lifecycle、再取得 inner writer lease，不调用
provider，先只读 classify/partition checkpoint proposals；checkpoint `TC` 不得进入 Task 5
ordinary tail-candidate reconcile。malformed/conflicting/mixed-invalid `P` 零写失败，不能先推进
event tail。唯一合法 old-tail `P` cleanup + directory fsync 或 new-tail partial GC 完成后，才执行
Task 5 ordinary event-successor/tail-candidate reconcile并稳定重读 persistent evidence；只有
clean-reconciled evidence 才能 mint facade/controller，provider 绝不建立在 startup old tail 上。

`installCheckpoint(authorityProvider)` 只接受上述 clean-reconciled facade。它重新取得 outer
lifecycle、inner writer lease，先运行同一个 read-only classifier。若存在 unreferenced event
successor、任何 checkpoint proposal/tail candidate 或 new-tail partial GC，则当前调用零写
`RECOVERY_REQUIRED`、fence facade/controller 并要求 fresh bounded reopen；不得 old snapshot →
reconcile → install。只有 clean classification 才稳定重读 current evidence，然后在本次新
checkpoint mutation 前同步且只调用 zero-argument provider 一次。provider 返回 recursively
exact frozen data-only：

```js
{
  snapshot: {
    incarnationId,
    tail: {seq, digest},
    cleanBasisDigest
  },
  cleanBasis: {
    admissionBasis,
    dbKey,
    schema,
    backend,
    finalSeq,
    triggerVersion,
    triggerSetDigest,
    projectInstanceIdSha256,
    identity,
    latestCleanBasisDigest,
    unresolved: []
  },
  epochObservations
}
```

每个 object/array（包括 admission event/payload、identity、unresolved 和 observations）必须
`Object.isFrozen()`，只有 exact own enumerable data properties；object prototype 必须 exact
`Object.prototype`，array prototype 必须 exact `Array.prototype`，accessor、symbol、extra key、
mutable nested value 和 thenable 一律拒绝。`epochObservations` 是 exact
frozen lowercase canonical UUID-v4 array，按 covered event 顺序、一条 authority-classified typed
event 一个 observation、重复保留。installation-time current checkpoint 为 `null` 时 authority
区间为 `[1,newCoveredSeq]`；非 null 时为
`(currentCheckpoint.coveredSeq,newCoveredSeq]`。

`snapshot.incarnationId/tail` 必须逐项等于双 lease 内 current persistent evidence；current tail
必须非空，且
`snapshot.cleanBasisDigest === cleanBasis.latestCleanBasisDigest === current tail.digest`。repeated
checkpoint 的 provider admission basis 必须与 previous checkpoint canonical bytes 完全相同，
core 写入 previous basis unchanged。对于实际新 install，core 同时派生 `previousCheckpoint`：
installation-time old persistent tail 没有 checkpoint 时 exact `null`，否则把该 tail 的
`checkpointFile/checkpointDigest/coveredSeq/coveredDigest` 逐项复制，并要求 new covered seq 严格
前进。core 自行派生 covered seq/digest、chainRoot、累计
eventTypeCounts、previous-bits OR new observations、epochObservationCount、exact
`unresolved=[]` 和 `retryContinuationOpen=false`，不接受 provider 提供这些派生值。provider
throw、promise/thenable、shape/observation 错误或 snapshot mismatch 固定
`RECOVERY_REQUIRED`、零写、无 receipt且不触发 installed-state uncertainty fence，不得映射成
`CONTROL_CHECKPOINT_BLOCKED`。Task 6 只能
证明“给定完整 authority observations 时 filter 不产生 false negative”；real native provenance
与 completeness 由 Task 7 exact parser 证明。

repeated checkpoint 若 stable `current tail.seq === previous coveredSeq` 且
`activeEventCount===0`，installer 仍调用并验证 provider exactly once；`epochObservations` 必须
exact `[]`；provider `cleanBasis` 必须 canonical-equal current checkpoint 的 exact clean-basis
projection `{admissionBasis,dbKey,schema,backend,finalSeq,triggerVersion,triggerSetDigest,
projectInstanceIdSha256,identity,latestCleanBasisDigest,unresolved}`；snapshot 仍独立遵守 current
incarnation/tail/cleanBasisDigest 规则。随后不触发 fault point、不写 candidate/tail、
不 GC；current checkpoint canonical bytes（包括 `previousCheckpoint`）与 persistent tail
逐字节不变，也不生成新 descriptor。待 writer/lifecycle release 全部 known-success 后返回
previous checkpoint 的 exact frozen no-op receipt `{checkpointDigest,coveredSeq}`。只有实际新装的
repeated checkpoint 才要求
`newCoveredSeq > oldCoveredSeq`；empty active suffix 不返回 `CONTROL_CHECKPOINT_BLOCKED`。current
checkpoint 与 persistent tail 都为空时没有 clean basis：provider/authoritySource 零调用，稳定
零写 `CONTROL_CHECKPOINT_BLOCKED`。

checkpoint 不得切断 logical retry，但 closure/retry 属于 Task 7：ProjectWriteCoordinator 的
closure-private writer turn 必须覆盖 source attempt 1、可选 attempt 2 和最终 retry 决策；turn
关闭后 maintenance 才按同一锁序进入。Task 7 bounded fixture 保持 frozen zero-argument public
`checkpoint()`，不接受 caller basis、token、consumer、observations 或
`retryContinuationOpen` raw boolean，而由 coordinator exact one-shot pending job 进入下一
exclusive maintenance turn。checkpoint 后首个 source 必须同时满足 `attemptSeq=1` 和
`previousAttemptSourceDigest=null`，任一不满足或任何跨 checkpoint continuation 都以
`NATIVE_ADMISSION_REJECTED` 拒绝。

Task 7 coordinator API 固定为 `withProjectLogicalRequestSync(projectKey, callback)`；其 internal
callback context 增加 `registerPendingCheckpoint(job)`，但只有 bounded wrapper 接收该 context，
wrapper 调用的 zero-argument user callback 不接收它。job exact frozen
`{snapshot,verifyCurrent,installCheckpoint}`，snapshot exact frozen
`{incarnationId,tail:{seq,digest},cleanBasisDigest}`，两个 function 都 close over 在 logical turn
lease 内捕获的 exact clean basis。outer turn 覆盖 attempt 1、可选 attempt 2 和最终 retry 决策；
只有 callback 与 lease release 都成功后，coordinator 才按 canonical project 保存 exact pending
job identity，不向 caller 返回 permit/basis。

internal `runPendingProjectMaintenanceSync(projectKey)` 由同一 store 的 zero-arg `checkpoint()`
调用。任何 intervening same-process write/recovery turn 使 pending stale/replace。runner 取得下一
cross-process exclusive writer lease 后、consume/任何 mutation 前调用 `verifyCurrent` 重读并
比较 ControlStore incarnation/tail、clean-basis digest 与 database identity/live predicates。
foreign evidence/identity-changing turn 造成 mismatch 时删除 job、稳定
`RECOVERY_REQUIRED`、零 checkpoint/tail/GC/SQLite mutation；foreign clean no-op 可继续。exact
match 后才原子 consume 并调用 private installer，throw/release uncertainty 不恢复 job。

#### 8.3.1 Task 7 bounded native fixture 与 checkpoint-aware frontier

Stage B testing entry 保持 `createStageBFixtureStore(fixture,options={})`。省略 `options`，或任何不含
`bounded` selector 且当前v1 validation 已接受的dependencies object，继续返回当前direct native
facade，目录字节、旧校验宽严与API均不变。任一own/inherited/accessor `bounded` selector 都在不调用
getter的前提下进入bounded validation，不得fallback到v1。bounded 路径只接受 exact
`Object.prototype` data object与key set
`{bounded:true,coordinator}` 或 `{bounded:true,coordinator,sqliteFactory}`；`bounded:false`、
`assertWriterLease` override、non-function `sqliteFactory`、custom prototype、accessor/symbol/extra
key 都在 filesystem/lease 前以 `NATIVE_ACTIVATION_DISABLED` 拒绝。`coordinator` 必须是同一个
`createProjectWriteCoordinator()` 返回对象，并在 fixture lifetime 中保持同一 bound
`withProjectLogicalRequestSync`、`runPendingProjectMaintenanceSync`、
`assertProjectWriteLease` identity。`project-write-coordinator.js` 用 module-private `WeakSet` brand
所有实际返回的 coordinator，并用
`Object.defineProperty(module.exports,'isProjectWriteCoordinator',{value:
isProjectWriteCoordinator,enumerable:false,writable:false,configurable:false})` 安装唯一跨模块
validator，不增加 enumerable export。factory 在 filesystem/lease 前调用它；duck 与
separately-loaded-module coordinator 均拒绝。

initial bounded construction 本身必须调用
`coordinator.withProjectLogicalRequestSync(fixture.databasePath,...)`。该 exclusive turn 按 same-key
规则先 invalidates 旧 pending；factory 只在 callback-active dynamic slot 内保存当次
`assertLease/registerPendingCheckpoint`，用 exact `{bounded:true}` 打开 ControlStore并构造 native
facade。construction 不调用 register，`finally` 清 slot，且只有 release known-success 才返回。

bounded result 是 test-only exact frozen `{store,withProjectLogicalRequestSync}`。`store` 保持现有
frozen native facade key set，`checkpoint()` 仍 zero-argument。wrapper 的
`withProjectLogicalRequestSync(callback)` 是 one-argument synchronous function：它进入新的 same-key
logical turn、设置 dynamic slot、调用不接收 authority/context 的 zero-argument user callback，再
执行 closure-private clean-turn pressure/job scheduling并在 `finally` 清 slot；known-success release
后返回callback exact non-thenable result。只有 wrapper 可调用
context capability `registerPendingCheckpoint`：`none` 零次，`soft`/`hard` exactly once；callback
throw/thenable或non-clean terminal零次。Coordinator不识别“native finalizer”，该限制只是call-graph/
API hygiene。caller 永远拿不到job builder、basis、observations、lease/token、context或register。
nested same-key wrapper call 稳定 `PROJECT_WRITE_REENTRANCY` 且零 pending mutation；cross-key 继续
既有规则。dynamic slot 外直接调用 `store.executeTransaction()`、`store.recover()` 或其他
lease-dependent method 在 SQLite/ControlStore 前稳定 `PROJECT_WRITE_REENTRANCY`；zero-argument
`checkpoint()` 自己进入 runner，故不需要旧 slot。
`server/testing/native-stage-b-store.js` 只构造/传递真实 bounded facade，不读取 hidden getter；
只有 real native module 是 Task 6 testing harness 之外的第二个 getter runtime caller。

bounded admission 使用 `readEvidence()`。checkpoint 为 null 时仍认证 seq-1 fixture genesis 并
parse 当前完整 evidence；checkpoint 非 null 时把
`checkpoint.admissionBasis.admissionEvent` 原样交给既有 fixture verifier，不能由 checkpoint
自证 authority。parser 从 authenticated checkpoint summary 精确 seed clean frontier：
`coveredSeq/coveredDigest,chainRoot,finalSeq,dbKey/schema/backend/triggerSetDigest,
projectInstanceIdSha256/identity,latestCleanBasisDigest,eventTypeCounts` 与
`retryContinuationOpen=false`，然后只验证从 `coveredSeq+1`/`coveredDigest` 开始的 active absolute
suffix，不读取已 GC covered events。

checkpoint 后第一条 source 必须 exact `attemptSeq=1,previousAttemptSourceDigest=null`；后续 retry
只能引用同一 active suffix 内同 logical request 的前一 source。parser 完成 admission、schema、
chain/state-machine 与 live predicate validation 后，才产生 exact frozen lowercase canonical
`activeEpochObservations`：当前 active interval 的 typed native event 每条一项、covered order、重复
保留；legacy/generic 同名字段不贡献。parser 不从 checkpoint summary/Bloom 合成 observation，也不
重读已 GC event。provider 的 `epochObservations` exact 等于该 active array：installation-time
checkpoint null 时区间是 `[1,newCoveredSeq]`（含仍active的认证 admission event）；non-null 时是
`(currentCheckpoint.coveredSeq,newCoveredSeq]`。

**Task 7 verification boundary：**该 private array 与 provider 继续不逃逸；不得新增 observer、
query/export、controller/facade key、injectable controller 或 testing escape hatch。自动化运行时证据
覆盖 checkpoint null/present interval membership、lowercase normalization、active/Bloom exclusion、
legacy/generic/checkpoint exclusion，以及真实 install 后的 Bloom bits 与累计
`epochObservationCount`（含 duplicate-per-event multiplicity）。covered order、每个 typed event 在
完整验证后 exactly once lowercase push、recursive freeze 与 same-private-array provider forwarding
由 focused source review 以 exact lines/counterexamples 证明，并经独立 C/I/M 审查闭合；Stage B
验收账本必须分别记录 runtime 与 static evidence，并明确 private array order 不可由运行时直接观察。

native facade 不再把已 GC 全历史 digest list 当作永久 prefix；它保留 checkpoint-aware admitted
frontier。成功或 no-op checkpoint receipt 后同步重读 exact ControlStore evidence 与 live DB/
identity predicates，将 frontier 推进到已安装 checkpoint并清掉 covered active prefix，同一 facade
继续可用。失败不推进；只有 uncertain/installed-state failure 或 fenced controller 才 isolation，
known zero-write `CONTROL_CHECKPOINT_BLOCKED` 不 isolate。provider 只在 exact
clean terminal/live validation 后 closure-private 构造 Task 6 exact frozen
`{snapshot,cleanBasis,epochObservations}`；`latestCleanBasisDigest` 是 current tail digest，所有
identity/basis/function capability 均不逃逸。

fresh epoch Bloom membership 固定在 `native-project-store.js` module-private 实现，不增加
controller key。它逐字复刻 Task 6 的 domain/basis/7-hash/23-bit/LSB-first 公式；测试用 Task 6
真实 filter cross-check vectors 防漂移。UUID-v4 验证后先 lower-case normalize，再同时排除 active
exact used set 与 inherited Bloom positive。最多生成 128 个候选；任一集合命中只拒绝该候选，
连续 128 个均被拒绝则在 SQLite activation/event append 前 fail-closed
`RECOVERY_REQUIRED`。clean/recovery open 的 fresh epoch 都走同一规则。

#### 8.3.2 Task 7 logical-request issuer 与 one-shot maintenance

Coordinator exact 新 API 是 `withProjectLogicalRequestSync(projectKey,callback)` 与
`runPendingProjectMaintenanceSync(projectKey)`。logical callback context 在既有字段外增加
`registerPendingCheckpoint(job)`；job 必须是 recursively exact frozen own-enumerable data object
`{snapshot,verifyCurrent,installCheckpoint}`，snapshot exact frozen
`{incarnationId,tail:{seq,digest},cleanBasisDigest}`，两个 function 必须 zero-argument synchronous。
accessor/symbol/custom prototype/extra/missing key、mutable nested value 或 thenable shape 在 staging
前以 private `TypeError` code `PROJECT_CHECKPOINT_JOB_INVALID` 拒绝。

register 是 callback context capability，不认证 caller provenance；Task 7 call graph只允许 bounded
wrapper 在 exact callback-active batch/canonical key/ownership token 下使用。它返回 `undefined`且
at-most-once：clean `none` 零次，clean `soft`/`hard` exactly once。duplicate、late/leaked/stale/
cross-project use 同码拒绝且零 pending mutation。它只 stage exact identity；callback success、final
lease validation 与 release known-success 后 coordinator 才 publish pending。callback throw/thenable、
lease loss/release failure均不 publish，并保持既有 primary/release mapping。caller不获得 permit/
basis/job identity。

任一后续同 canonical key outer `withProjectWrite`、`withProjectWriteSync`、
`withProjectRecoveryLeaseSync` 或 `withProjectLogicalRequestSync` 在 recovery/callback 前 invalidates
旧 pending，即使该 turn 随后失败；initial bounded construction同样执行该规则，新的 successful
logical turn可 replace。alias 是同 key，different key 不互相影响。nested same-key
`withProjectLogicalRequestSync` 在 invalidation/staging 前稳定 `PROJECT_WRITE_REENTRANCY`；cross-key
按既有 coordinator rule。

maintenance runner 先按 outer-admission 规则检查 running，后 canonicalize/acquire；missing、stale、
invalidated 或 consumed job 稳定 `CONTROL_CHECKPOINT_BLOCKED`。outer-admission rejection、
`PROJECT_WRITE_BUSY` 或其他 lease-acquire failure 都发生在 consume 前并保留 same pending identity。
它使用新的 `recover:false` exclusive project writer turn，不先调用 `recoverProject`。持 lease 后捕获
pending identity，并在该新 owned writer context 内先调用 `verifyCurrent()`；verify 内发起 same-key 或
cross-key public logical call 都属于 nested call，在 pending invalidation/staging 前稳定
`PROJECT_WRITE_REENTRANCY`。verify 返回后仍核 map 是同一 identity，作为防未来 internal mutation 的
defense-in-depth；当前 public API 无法在 verify 内 replace pending，Task 7 也不增加 private test seam。
若防御检查仍观察到不同 identity，runner保留该identity、不调captured installer并稳定返回
`RECOVERY_REQUIRED`。false/throw/thenable 后只 conditional-remove/invalidate captured job且绝不restore，false/throw映射
`RECOVERY_REQUIRED`（cause identity保留），thenable 映射 `PROJECT_WRITE_ASYNC_CALLBACK`。exact true+
identity recheck 后 atomic consume再调用 `installCheckpoint()`；install任何return/throw/thenable、
lease loss或release uncertainty都不restore。non-thenable receipt/error identity保留，既有 writer-
lease loss仍优先。

native `verifyCurrent` 重读 persistent ControlStore incarnation/tail/clean-basis digest 与 database
identity/live clean predicates。foreign evidence/identity drift 因而在 checkpoint/tail/GC/SQLite
mutation前 `RECOVERY_REQUIRED`；foreign clean no-op若全部比较值 exact unchanged 可继续。installer
只持 closure-private provider/controller，不复用已 release 的 logical-turn token。

pressure 只在 outer logical request boundary评价。已 admission request 必须先覆盖 attempt 1、可选
attempt 2、最终 retry decision 与 terminal；generic append/CAS永不被 high-water拒绝。clean terminal
后 `none` 不stage，`soft`/`hard` 都以最新 exact job replace/coalesce到每project一个pending。Stage B
不创建 background thread：`store.checkpoint()` 是唯一 explicit soft runner，exact delegate
`runPendingProjectMaintenanceSync(fixture.databasePath)`。bounded wrapper 在下一 logical callback 前
同步执行当前 hard job；missing/stale/no-clean job或Task 6 safe-cap failure为
`CONTROL_CHECKPOINT_BLOCKED`，新 callback/source不开始。hard success推进frontier后才admit；soft不
延迟 admission，只由 explicit zero-arg checkpoint运行。

`beginQuiesce()` 必须在 path/lock/recovery 前拒绝新 logical request 与 maintenance runner，不启动
任何 pending work。已开始 runner作为 admitted batch由 `drain()`等待完成/失败；仅 pending job不
占 batch、不阻塞 drain。draining starts none；低于soft的shutdown不创建checkpoint。
`server/tests/shutdown-coordinator.test.js` 必须加入 Task 7 Files并继续冻结“all outer mutation”合同。

#### 8.3.3 Task 7 internal diagnostics

`server/native/native-diagnostics.js` exact enumerable export 只有
`projectNativeDurabilityDiagnostics(evidence)`。这是 shape-only projector：caller必须先通过native
admission/parser认证同一 evidence；projector只验证 input recursively exact frozen 且匹配 bounded
`readEvidence()` schema，不brand也不建立provenance。output recursively exact frozen
`{checkpoint,activeSuffix}`，checkpoint 为
`null` 或 `{checkpointDigest,coveredSeq}`，activeSuffix exact
`{eventCount,eventBytes,tailSeq}`，三值来自已验证 input tail counters。不得返回 path、payload、Bloom、
admission/identity、raw event或mutable alias。该 projector仅 fixture tests import；public
RecoveryDiagnostics/REST/TypeScript DTO 到 Stage C 前不变。

### 8.4 persistent tail、append 与 reconcile

tail commit record 固定为 `.controlstore-tail.json`，`recordDigest` 对去掉自身字段后的
canonical JSON 计算：

```json
{
  "version": 1,
  "recordDigest": "<64 lowercase hex>",
  "controlProtocolEpoch": 2,
  "incarnationId": "<uuid-v4>",
  "checkpointFile": ".controlstore-checkpoint-12345-<digest>.json",
  "checkpointDigest": "<64 lowercase hex>",
  "coveredSeq": 12345,
  "coveredDigest": "<64 lowercase hex>",
  "tailSeq": 12345,
  "tailDigest": "<64 lowercase hex>",
  "activeEventCount": 0,
  "activeEventBytes": 0
}
```

尚无 checkpoint 时 `checkpointFile/checkpointDigest/coveredDigest=null`、`coveredSeq=0`。
完全空 bounded evidence 固定 `tailSeq=0,tailDigest=null,activeEventCount=0,
activeEventBytes=0`。非空时 `activeEventCount=tailSeq-coveredSeq`；checkpoint-only evidence
的 tail ref 等于 covered ref 且 active count/bytes 为 0。activeEventBytes 只累计 active
official event canonical UTF-8 bytes。首个 active event 必须是 `coveredSeq+1` 且
`prevDigest=coveredDigest`，绝不重编号。

`recordDigest` 覆盖包括 `checkpointFile/checkpointDigest` 的所有其他 tail 字段；引用必须与
referenced checkpoint 逐项匹配，不能替换、分离或自带另一份 filter。

bounded append 固定执行 event candidate/publish、file+directory fsync，再执行 tail
candidate/file fsync、atomic replace/directory fsync，最后双读 event/tail post-check 才返回。
`.controlstore-tail.json` 是 checkpoint 激活提交点；tail post-check 前不得 GC。official
event 已发布但双 post-check 尚未完成时的同步 failure 首次抛 `RECOVERY_REQUIRED` 并 fence
当前 facade；该 facade 后续所有方法固定 `CONTROL_STORE_FENCED`。event publish 前且 cleanup
可证明的 I/O failure 沿用 `CONTROL_STORE_IO`。

bounded bootstrap/append 已完成 tail/event exact 双 post-check 后，inner writer lease 或 outer
lifecycle lease release throw/状态不明仍是已安装后的 uncertainty：首次稳定
`RECOVERY_REQUIRED`，不得返回 receipt；已有 facade 立即 fenced，后续方法固定
`CONTROL_STORE_FENCED`。bootstrap 尚未产生 facade 时 open 直接抛错，新 bounded reopen 必须
从 persistent tail 唯一收敛且不得 duplicate。primary error 的 `cause` 保留第一个 mapped
release failure identity，后续 release failure 追加 `secondaryErrors`，不能退化成普通
`CONTROL_STORE_IO`。publish 前无 commit 且 cleanup exact proven 的 failure 继续沿用原 I/O
语义。

pure-v1/empty bootstrap tail 采用相同 uncertainty cut：atomic replace 可能已安装 final 后的
同步 failure 首次返回 `RECOVERY_REQUIRED` 并 fence；只有 publish 前 failure 且 candidate
cleanup exact proven 才返回 `CONTROL_STORE_IO`。

bounded reopen 只在 writer lease 内 reconcile：没有 successor 保持 tail；唯一 exact
`tailSeq+1` successor 被验证并 durable advance tail。hole、multiple successor、wrong
seq/prevDigest/digest 或 present-but-mismatch 固定 `RECOVERY_REQUIRED`，不得猜测或第二次
append。

checkpoint startup/reopen 只以 persistent `.controlstore-tail.json` 为 authority，并固定发生在
bounded open bootstrap 的 facade/WeakMap mint 前：先取得 lifecycle + writer 双 lease并只读
classify/partition checkpoint proposals。checkpoint `TC` 只属于下面的 `P`，绝不进入 Task 5
ordinary tail-candidate reconcile；malformed/conflicting/mixed-invalid `P` 必须零写失败，不能先
advance event tail。startup 全程不调用 provider。

- 令 `C=checkpoint candidate`、`F=hard-linked orphan final`、`TC=checkpoint-tail candidate`。
  old tail 仍在时，合法 proposal 集合 `P` 只允许 `{C}`、`{C,F}`、`{F}`、`{F,TC}`；
  `{C,F}` 必须证明 exact hard-link identity/canonical bytes，`{F,TC}` 的 coveredSeq/digest 与
  tail candidate 对 orphan final/old tail 的 linkage 必须逐项一致；bounded open
  bootstrap cleanup 唯一合法 `P` 的全部成员（singleton 同样）后只做一次 directory fsync，
  不得激活、advance authority tail 或
  GC covered event/old checkpoint。`P` topology/classification 与 proposal checkpoint 中的
  `previousCheckpoint` 无关；该字段此时只做机械 schema 验证，不授权追随或删除 predecessor；
- persistent tail 已引用 new checkpoint 时，该 checkpoint 才是 authority；没有 candidate
  conflict 时，合法集合只含 current referenced final、covered-event residue 与由 current
  checkpoint digest-covered `previousCheckpoint` 精确命名的 predecessor。descriptor 为 `null` 时
  不允许任何 unreferenced checkpoint final；descriptor 非 null 且 target 缺失时视为 predecessor
  已删除；target 存在时必须是唯一 unreferenced final，core 完整解析其 exact checkpoint schema、
  重算 checkpoint digest，并要求 actual basename 等于 descriptor `checkpointFile`、parsed
  checkpoint 的 `checkpointDigest/coveredSeq/coveredDigest` 分别等于其余三字段后才删除。
  不得按 coveredSeq、数量或文件名相似度猜测；任何额外 exact final 或 valid-but-mismatch target
  固定 `RECOVERY_REQUIRED`，任何 malformed final 固定 `CONTROL_STORE_CORRUPT`。bootstrap 幂等
  删除合法 GC residue 并 fsync directory，
  partial GC 不回滚 tail；若该现场仍有任何 checkpoint candidate，即使与 referenced
  checkpoint byte-identical，也沿用 Task 5 frozen negative：writer/inspector 都零写
  `RECOVERY_REQUIRED`，不得 cleanup；
- 只有唯一合法 `P` cleanup + directory fsync 或 new-tail partial GC 完成后，bootstrap 才运行
  Task 5 ordinary event-successor/tail-candidate reconcile并稳定重读；任何 authority-changing
  successor 都在 controller/provider mint 前吸收；
- tail replace 是否发生过或曾返回不确定，重启只按上述两支读取 persistent tail，不采信
  fault 进程的内存阶段；
- `TC` without `F`、pair mismatch、两个 proposal `P` 同时存在、multiple/conflicting candidates、
  非 GC residue orphan、同 coveredSeq 不同 checkpoint digest 或 present-but-mismatch 固定
  `RECOVERY_REQUIRED`、零猜测；malformed candidate/final、
  referenced checkpoint missing/corrupt 固定 `CONTROL_STORE_CORRUPT`；
- read-only inspector 始终零写；任何 exact candidate/orphan 固定
  `RECOVERY_REQUIRED`，malformed 固定 `CONTROL_STORE_CORRUPT`；它不 cleanup、不 GC，也不返回
  partial projection。

read-only inspector 永不 cleanup、advance tail 或 consume successor。发现 exact candidate
或唯一未引用 successor 时零写返回 `RECOVERY_REQUIRED`、不返回 partial projection；malformed
candidate 是 `CONTROL_STORE_CORRUPT`。只有 bounded writer 在 writer lease 内可以 cleanup/
reconcile；default writer 一见 candidate 就零写 `CONTROL_STORE_PROTOCOL_UNSUPPORTED`。

fault constants 固定为：

```text
CONTROL_STORE_TAIL_BEFORE_PUBLISH  = controlstore.tail.before-publish
CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC = controlstore.tail.before-dir-fsync
CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH = controlstore.checkpoint.before-publish
CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK = controlstore.checkpoint.before-candidate-unlink
CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC = controlstore.checkpoint.before-final-dir-fsync
CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC = controlstore.checkpoint.after-final-dir-fsync
CONTROL_STORE_CHECKPOINT_BEFORE_GC = controlstore.checkpoint.before-gc
CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY = controlstore.checkpoint.after-gc-entry
CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC = controlstore.checkpoint.before-gc-dir-fsync
```

真实强杀固定六行：pure-v1 bootstrap tail 的两个 tail 点；bounded append event 的 existing
`CONTROL_STORE_APPEND_BEFORE_PUBLISH/BEFORE_DIR_FSYNC`；bounded append tail 的两个 tail 点。
parent 在 bounded writer reopen/reconcile 前不得先调用其他 writer；read-only inspector 可
证明 candidate/successor 零写 `RECOVERY_REQUIRED`，但绝不消费或投影它。每行证明 exact
evidence、无 duplicate、count/bytes 和 next absolute seq。

七个 checkpoint cuts 精确位于：checkpoint candidate file fsync 后/final hard-link 前；hard-link
后/candidate unlink 前；unlink 后/final directory fsync 前；final directory fsync 后/tail
activation 前；new tail post-check 后/首个 GC 前；每删除一个 covered event 或 old checkpoint
后；全部删除后/GC directory fsync 前。checkpoint tail activation 复用 Task 5 两个 tail fault，
但 context 必须额外 exact data property `operation:'checkpoint-activation'`；
`CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY` context 必须包含 exact
`entryKind:'event'|'old-checkpoint'` 和目标 basename `entryName`，使 partial GC 两类可区分；
old-checkpoint row 的 `entryName` 必须 exact 等于 current checkpoint
`previousCheckpoint.checkpointFile`。descriptor target 已缺失时不得发出 old-checkpoint delete 或
该 entry fault。

错误与 commit cut 固定为：

- Task 6 zero-mutation `CONTROL_CHECKPOINT_BLOCKED` 只允许：empty/no-clean-basis，或
  inherited-OR candidate actual popcount `>4,194,304`；两者都在 checkpoint final/tail/GC
  mutation 前完整保留旧 evidence。Task 7 hard admission
  没有 exact clean pending job 也使用该码，但 Task 6 generic append 不使用；
- provider throw/thenable/shape/observation/snapshot mismatch 是零写
  `RECOVERY_REQUIRED`，不得伪装为 blocked 或 ordinary I/O；
- old tail 仍权威，且 checkpoint candidate/orphan cleanup + directory fsync 已 exact proven 时，
  pre-tail 原始 I/O failure 才返回 `CONTROL_STORE_IO`；
- release mapping 冻结 `authorityMutationAttempted=false` 贯穿 checkpoint candidate/final 与
  tail candidate write/fsync；`CONTROL_STORE_TAIL_BEFORE_PUBLISH` fault 成功返回后、紧邻 tail
  `atomicReplace` 前才设 true；new tail exact post-check 后才设 `turn.installed=true`。结合 Task 5
  mutation disposition，provider/snapshot 的
  zero-write `RECOVERY_REQUIRED` 或 empty-store/Bloom-cap 的 zero-write
  `CONTROL_CHECKPOINT_BLOCKED` 若伴随
  release failure，保留 semantic primary、不 fence：Recovery primary 将 release failures 追加
  到 `secondaryErrors`，non-Recovery primary 沿用 Task 5 `cleanupError` attachment。无 primary、
  zero mutation（包括 pending no-op receipt）的 release failure 沿用 `CONTROL_STORE_IO`；
- 只有 `authorityMutationAttempted===true`、`turn.installed===true`，或 checkpoint/tail/GC mutation
  disposition unknown 时，operation/
  release failure 才在当前调用首次 `RECOVERY_REQUIRED`、无 receipt 并 fence facade/controller；
  后续 methods 固定 `CONTROL_STORE_FENCED`。primary `cause` 保留第一个 mapped failure 对象
  identity，后续 release failures 追加 `secondaryErrors`，沿用 Task 5 规则；
- installed-state uncertainty 绝不能被 `CONTROL_CHECKPOINT_BLOCKED` 覆盖；fresh bounded reopen
  只按 persistent tail 执行上述唯一收敛。
- bounded-open bootstrap 尚无 facade：合法 `P` cleanup 或 new-tail partial-GC mutation 已成功后
  若 writer/lifecycle release failure，open 固定抛 `RECOVERY_REQUIRED` 且只允许 fresh bounded
  reopen 收敛；zero-bootstrap-mutation 的 release-only failure 沿用 `CONTROL_STORE_IO`。不得返回
  半初始化 facade/controller，也无 facade 可 fence。

### 8.5 有界后缀与任务边界

- internal controller-only `maintenanceStatus()` 先以 `CONTROL_STORE_FENCED` 拒绝 fenced
  controller，再在 lifecycle lease 下复用只读 classifier，零写、零 provider call。fresh open
  已在 controller mint 前完成 partial GC；若后来出现 exact unresolved candidate/orphan/
  successor 或 partial-GC state，返回 `RECOVERY_REQUIRED`，malformed metadata 或 referenced
  checkpoint missing/corrupt 返回 `CONTROL_STORE_CORRUPT`，绝不返回 stale level。clean 时才返回
  exact frozen `{activeEventCount,activeEventBytes,level}`；
- level 使用 count/bytes 的 OR 与 inclusive threshold：count `>=4,096` 或 bytes `>=16 MiB`
  为至少 soft，count `>=8,192` 或 bytes `>=32 MiB` 为 hard，否则 none；
- Task 6 只计算/report pressure，不在 generic bounded `append()` 或 `compareAndAppend()` 增加
  high-water 拒绝；已经 admission 的 logical request、optional retry 与 terminal 必须完整闭合；
- Task 7 才在 outer logical-request boundary 调度，但不创建 background thread：soft 只
  coalesce 最新 exact pending job，由 explicit zero-argument `store.checkpoint()` 同步运行；hard
  必须在**下一次 admission** 的 logical callback/source 开始前同步运行下一 exclusive
  maintenance turn。没有 current exact clean job 时该 admission 返回
  `CONTROL_CHECKPOINT_BLOCKED`，不阻断前一 terminal；
- 只有 checkpoint、tail 与 successor 链 post-check 后才能删除已覆盖 segment。
- checkpoint success receipt exact frozen `{checkpointDigest,coveredSeq}`，只能在 checkpoint
  final/tail post-check、幂等 GC、GC directory fsync、final verification 与 writer/lifecycle
  lease release 全部 known-success 后返回；active-suffix-zero no-op 返回 previous exact receipt，
  同样必须等 provider once 与双 release known-success，但目录及 current
  `previousCheckpoint` 逐字节不变。

Task 5 baseline 实现 parser、tail、bootstrap 与 reconcile；Task 6 为 digest-covered
`previousCheckpoint` exact schema 更新该 parser/test，但 parser 只机械验证 descriptor 且不得检查
old final 是否存在。Task 6 installer 证明 first-null/repeated-exact lineage inheritance 并执行
descriptor-only predecessor GC，同时创建 checkpoint、报告 pressure、执行 epoch-2 Bloom cap，
但不阻断 generic append。Task 7 才执行 hard admission
scheduling，让 NativeProjectStore 以 checkpoint `admissionBasis` + clean summary + active
suffix 认证 aged history，并执行 Bloom-negative + active-unused epoch admission。旧
Stage B fixture factory 保持 default-v1；Task 7 在 `server/testing/native-stage-b-store.js`
增加独立 `{bounded:true}` fixture path，把 exact copied admission event 原样交给既有 verifier。

Task 7 tracked scope exact 为：modify `server/control-store.js`、
`server/project-write-coordinator.js`、`server/native/native-project-store.js`、
`server/testing/native-stage-b-store.js`、`server/tests/project-write-coordinator.test.js`、
`server/tests/shutdown-coordinator.test.js`、`docs/superpowers/plans/l1-benchmarks.md`；create
`server/native/native-diagnostics.js`、`server/tests/native-diagnostics.test.js`、
`server/tests/control-store-aged-history.test.js`、
`server/tests/native-durability-benchmark.test.js`。不得修改 `server/db.js`、
`server/testing/native-stage-b-fixture.js`、shutdown implementation、production open/write wiring、
schema 10/11 activation mode、public diagnostics/REST/TypeScript DTO、Task 8 acceptance/build-sidecar
文件或 release 流程。

### 8.6 与 shutdown 解耦

graceful shutdown 不因低于 trigger 而创建 checkpoint。

已有 maintenance 可以在 quiescing 前完成或中止；进入 draining 后不得新启动非必要 checkpoint。

退出成功只证明所有协议已终结并且资源 disposition 已知，不声称生成了新备份。

上述 shutdown/maintenance sequencing 的实现与 RED/GREEN 属于 Task 7；Task 6 不读取 shutdown
state、不修改 shutdown coordinator，也不以 shutdown 驱动 checkpoint。

## 9. 正常写事务

令当前 durability_commit_seq = S。

提交顺序固定为：

1. ProjectWriteCoordinator 取得 writer lease；
2. 恢复已有未终结协议；
3. 验证 connection epoch 与 DatabaseIdentityGuard；
4. 追加 manuscript.source；
5. 追加 sqlite.tx.prepared，绑定 S 与 S + 1；
6. BEGIN IMMEDIATE；
7. 验证 schema 上界、backend、gate、trigger version/triggerSetDigest 三方一致和 seq；
8. 临时打开 gate；
9. 执行业务 DML 与 CAS；
10. 把 durability_commit_seq CAS 为 S + 1；
11. 清空 gate；
12. COMMIT；
13. 回读 seq、gate、trigger version/triggerSetDigest、instance 和 identity；
14. 追加 sqlite.tx.committed；
15. 返回业务成功。

任何业务成功响应都必须晚于 committed event post-check。

### 9.1 COMMIT 前失败

BEGIN IMMEDIATE 失败和事务开始后的失败使用两个不同谓词：

1. **从未取得写锁**：BEGIN 返回 BUSY/LOCKED，connection 仍处于 autocommit，且 gate、业务 DML 与 seq SQL 一条也未执行。不得调用 ROLLBACK；追加 rollbackKind=begin_not_acquired 的 rolled_back 后返回 PROJECT_WRITE_BUSY。
2. **已经开始事务**：preflight、CAS 或业务逻辑在 BEGIN 成功后失败。必须成功 ROLLBACK，并证明 seq、空 gate、trigger version/triggerSetDigest 和 identity 等于事务开始后的 pre-write snapshot，才可追加 rollbackKind=transaction_rolled_back。

ROLLBACK、autocommit 或 connection disposition 不明时 logical fence 当前 epoch，返回 RECOVERY_REQUIRED，不猜测 terminal。

transaction callback 必须同步且独占。callback 返回/抛错后 statement facade 立即失效；
Promise/thenable 按 transaction failure 回滚。同一 store 在 callback 期间的外层 read、递归
transaction、recover/checkpoint、close/fence 均零副作用拒绝，不能关闭正在提交的连接。

一旦开始调用 COMMIT，就不再属于可安全 ROLLBACK 的“COMMIT 前失败”。COMMIT 抛错、返回
后仍非 autocommit，或首次 post-COMMIT predicate/identity read 不确定时，均不调用
ROLLBACK、不追加 terminal，立即 fence 并返回 RECOVERY_REQUIRED；后续只允许 recovery
依据 DB seq 收敛。

**已接受的取舍**：prepared 在 BEGIN 前 durable append，因此一次外部占用导致的 busy 保存会产生一组 prepared + rolled_back 事件；加上既有 manuscript.source，该次尝试共增加三个事件，而不是零事件。客户端只允许一次有界自动重试，持续占用后停止重试并保留草稿；ControlStore checkpoint/high-water 保证历史有界。实现和基准必须单独报告 busy 事件增长，不能把它当作异常泄漏。

### 9.2 COMMIT 后 terminal 失败

不向客户端报告业务成功。

当前 connection epoch 立即 fenced。

下一次恢复按数据库 seq 判断：

- seq = S：rolled_back；
- seq = S + 1 且全部 predicate 精确：committed；
- 其他值或 predicate 不一致：RECOVERY_REQUIRED。

## 10. 崩溃恢复

恢复始终在 writer lease 内执行。factory 先把 suffix 精确分类为 clean、source-only 或
prepared；source-only 按 §7.3 交还调用者 cleanup，不接触 SQLite。prepared recovery 在
任何 SQLite 打开前验证 canonical path、dbKey、只读 pathname identity、ControlStore exact
tail、冻结的 project instance/admission evidence 与 writer lease；`sqliteFactory` 打开精确路径后，
在第一条可能触发 hot-journal recovery 的 SQLite statement 前再次验证 pathname/handle
identity、ControlStore exact tail 与 writer lease。两次验证间任一变化都必须在零 SQLite
statement、零 terminal append 下 fail-closed。只有该受控 connection 可以触发 journal recovery；随后立即验证
schema/backend、instance、gate、seq、trigger 三方 digest 和最终 identity。

| 现场 | 唯一动作 |
|---|---|
| clean basis / 无未终结事件 | 保持 active；`recover()` 返回 clean，不轮换 epoch |
| source-only | 返回 source_pending；由调用者追加 exact abandoned 后再恢复 |
| prepared，DB seq = beforeSeq | 生成 fresh recovery epoch，验证 gate、trigger version/triggerSetDigest、identity 后追加 rollbackKind=recovery_before_commit 的 rolled_back |
| prepared，DB seq = expectedFinalSeq | 生成 fresh recovery epoch，验证 schema/backend/gate、trigger version/triggerSetDigest、identity 后追加 recovered committed |
| seq 跳跃、gate 非空、trigger version/digest 三方不一致、实例不符 | RECOVERY_REQUIRED |
| 多个 successor 或 tail 不在唯一链 | RECOVERY_REQUIRED |
| SQLite hot journal | 只由同一受控 connection 在 lease 内恢复，再重新判定 |

`recover()` 的 exact return union 只有：

- clean：`{status:'clean',finalSeq,connectionEpoch}`；
- source-only：`{status:'source_pending',sourceDigest,finalSeq,connectionEpoch:null}`；
- prepared terminal：
  `{status:'rolled_back'|'committed',preparedDigest,terminalDigest,finalSeq,connectionEpoch}`。

prepared terminal 的 connectionEpoch 是上述 fresh recovery epoch；terminal durable append、
重读与 post-check 全部成功后 facade 才转为 active。崩溃前 statement、transaction、guard 和
facade 永久 stale；source-only facade 在 exact abandoned successor 后可以被同一对象重新
验证，但在 active 前仍不持有 SQLite connection。

## 11. v1 到 native 激活

### 11.1 前置条件

激活前必须满足：

1. activation mode 允许当前 root；
2. ConfigLifecycleLease 与项目 writer lease 已取得；
3. 当前路径是受支持的普通本地文件，dbKey 未变化；
4. v1 AtomicStore 已完成自动恢复；
5. 没有未终结 v1 publication；
6. 最新 v1 terminal、正式字节、formal SHA-256、identity 和 project instance 一致；
7. integrity_check 与 foreign_key_check 通过；
8. schema = 10，且不存在 native backend、gate 或 downgrade trigger；
9. 两个平台 native durability capability 对当前构建和文件系统均为 true；
10. Task 8、D9、D10 和前置基础门禁已经通过兼容模式本地验收；无需 installer、tag、release 或用户安装记录。

缺失任一条件时保持 v1，不写 activation event 或数据库 marker。

### 11.2 激活步骤

1. 冻结 v1 anchor 与完整 hash；
2. 追加 activation.prepared；
3. logical fence v1 facade，推进 epoch并关闭 v1 connection；
4. 重新读取正式文件，要求 identity 与完整 hash 仍等于 prepared source；
5. 用 bun:sqlite 打开同一 identity；
6. BEGIN EXCLUSIVE；
7. 再次核对 schema 上界、instance 和无 native marker；
8. 由 canonical generator 创建 gate 与完整 trigger set；
9. 设置 schema 11、backend、seq 0、trigger version 与 generator 的 expected triggerSetDigest；
10. COMMIT；
11. 从 sqlite_schema 重算 observed triggerSetDigest，并与代码 expected/project_meta 三方比对后回读其余 predicate；
12. 追加 activation.activated；
13. 关闭激活 connection；
14. 从头以 NativeProjectStore 打开并创建新 epoch。

在 activated post-check 前不得向业务返回 native 句柄。

### 11.3 激活中断

| ControlStore | 数据库 | 处理 |
|---|---|---|
| prepared | 完整 v1，hash 仍等于 source | 重试同一 activationId 或追加 aborted |
| prepared | 完整 v1，但 hash 已变化 | 先完成 v1 recovery；确认没有任何 native state 后追加 aborted，再从新 anchor 开始 |
| prepared | 完整 schema 11 native predicate | 追加 activated |
| prepared | 部分 marker、错误 trigger、错误 seq | RECOVERY_REQUIRED |
| activated | 完整 schema 11 native predicate | 正常 native open |
| activated | predicate 不一致 | RECOVERY_REQUIRED |

SQLite schema/backend/trigger/gate 在同一事务中，正常 crash 不应产生部分状态；观测到部分状态即视为外部修改或实现错误。

### 11.4 降级行为

真实 v0.0.7、v0.0.8、v0.0.9 产物必须作为负对照：

- schema 10 项目可以执行其历史业务 DML；
- schema 11 项目的可写表清单、每表 INSERT/UPDATE/DELETE 语句和 expected trigger rows 都从 production canonical trigger generator 派生，测试不得手写第二份表清单；
- 每条旧版本 DML 都失败；旧进程关闭后，项目数据库文件逐字节等于测试前快照，ControlStore 目录文件集合与全部字节也完全不变。

未来兼容版本在 schema > 自身上限时应显示“项目需要更高版本”，但用户是否安装过该版本不是 native 激活前置条件。

安装器不得把已存在 schema 11 项目的 data root 自动回滚到旧版本。release notes 明确旧版本不能继续编辑 native 项目。

## 12. identity、路径与资源状态

### 12.1 DatabaseIdentityGuard

NativeProjectStore clean open 时冻结正式数据库的受控 handle identity。cold recovery 在
打开前冻结 pathname/read-only handle identity，并按 §10 在 `sqliteFactory` 后、第一条
SQLite statement 前复核同一物理对象；prepared 现场的 identity 不一致必须在可能恢复 hot
journal 前阻断。

每个事务开始前和 COMMIT 前重新验证：

- pathname 仍指向同一物理对象；
- 不是 symlink、junction、generic reparse 或额外 hardlink；
- canonical path 与 dbKey 未变；
- project_instance_id 未变。

错误映射固定如下：clean open 或 source-only cold facade 在接触 SQLite 前发现 same-path
replacement，返回 `NATIVE_DATABASE_IDENTITY_STALE`；prepared/recovery 现场的 identity
mismatch 返回 `RECOVERY_REQUIRED`，并保证第一条 SQLite statement 尚未执行；active 后发现
replacement 走普通 transaction rollback/fence 或 operation fence。admission basis 或 suffix
状态机本身不合法仍返回 `NATIVE_ADMISSION_REJECTED`，不得借 identity 错误掩盖。

### 12.2 same-path identity adoption

Task 8 只有在以下条件全部成立时才设置 canAdoptIdentity = true：

1. canonical path 与 dbKey 未变；
2. 旧 identity 与新 identity 不同；
3. 没有未终结 source、transaction 或 activation；
4. 候选是受控普通单链接文件；
5. 没有 hot journal；
6. integrity_check 与 foreign_key_check 通过；
7. project instance、schema、backend、seq、gate、trigger version 与 triggerSetDigest 三方比对精确等于最新 clean basis；
8. 用户通过 POST 明确确认“接受协议一致但不保证字节相同的新物理对象”。

POST 在 writer lease 内重新检查 snapshot，追加 sqlite.identity.adopted，关闭所有旧对象，再从头打开。

任一检查不成立时零修改。GET 和普通 open 永不自动 adoption。

上述 adoption 是 Task 8 的显式用户动作，不改变 Task 4 的 same-path replacement mapping：
cold/active facade 都不能自动接受新 identity，prepared recovery 更不能先触发 journal
recovery 再把 replacement 解释为可 adoption。

### 12.3 data-root 与项目路径变化

same-path adoption 不能改变 canonical path 或 dbKey。

存在 native v2 项目时，data-root 修改和项目路径迁移返回 NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED。不得复制后直接修改 config，也不得通过 adoption 绕过。

这项限制是明确的产品边界，不用临时 path_rebind 协议填补。

### 12.4 connection、guard 与 lease

资源状态采用：

- recovery_required；
- active；
- fenced；
- closing；
- released；
- disposition_unknown。

`fenced` 是 Task 3 已冻结的 public `state` 值。本文其余位置的 “logical fence” 只描述内部
隔离动作，成功且资源 disposition 可证明时对外必须映射为 `state='fenced'`；不得改名为
`logical_fenced`，也不得改变既有 getter 或测试。

`recovery_required` 是尚未创建 SQLite connection 的 cold facade 状态，转换只允许：

| 起点 | 动作与已证明结果 | 终点 |
|---|---|---|
| cold construction | exact suffix 为 source-only 或 prepared；`connectionEpoch=null` | recovery_required |
| recovery_required | source-only 的 caller-owned exact abandoned 已成为唯一 successor，随后从头 open/live validation 成功并生成 fresh epoch | active |
| recovery_required | prepared recovery terminal 已 durable append、重读并 post-check，且生成 fresh epoch | active |
| recovery_required | `close()` 完成全部 cold resource/lease release | released |
| recovery_required | `fence()` 关闭 guard 与全部已持有 resource，且 disposition 可证明 | fenced |
| recovery_required/closing | close 或 release disposition 不可证明 | disposition_unknown |

cold `close()` 可以内部经过 `closing`，但成功返回时必须已是 `released`；cold `fence()` 不得
打开 SQLite，只有 guard/全部已持有 resource 成功关闭后才可返回 public `state='fenced'`；
任一 close/release disposition 不可证明都必须进入 `disposition_unknown`。上述每条转换都受
同一个同步 operation guard 保护；除两个成功 recovery 转换明确允许的受控 open 外，其余
转换均保持零 SQLite statement，且不能隐式追加 source、abandoned 或 transaction terminal。

底层 close/release 调用成功前不能先把状态标为 released。

任何 operational error 都先 logical fence。disposition_unknown 时禁止 query、write、activation、adoption、rename/delete、data-root 修改和进程内重新获取。
每个 store 同时只允许一个同步 operation；operation guard 必须覆盖 read、transaction、
recover/checkpoint、close/fence 与 callback 重入，不能只保护 statement facade。

## 13. 平台能力与 POSIX verified install

### 13.1 平台矩阵

| 平台 | SQLite journal 证据 | 应用目录项证据 | 首版策略 |
|---|---|---|---|
| Windows NTFS | 编译后 Bun/SQLite/VFS + VM hard-reset crash matrix | ControlStore/activation/checkpoint 每个 install 点硬重置 | 两个 capability 均通过才启用 production |
| Linux 指定本地文件系统 | DELETE/EXTRA 与实际 VFS；实机 crash test | 目录 FD + fsync + no-clobber install | 按文件系统白名单启用 |
| macOS | 尚无目标 APFS 证据 | 尚无 verified no-clobber 证据 | capability false，保持 v1 |
| 网络盘、云盘占位、reparse root | 不受支持 | 不受支持 | native activation 零写入 |

API probe、VM reset 和物理断电证据必须分开陈述。

### 13.2 POSIX missing-formal verified install

该协议只服务于遗留 v1 recovery：ControlStore 已唯一证明 committed，正式文件 missing，候选字节与 expected hash 精确匹配。

Linux 启用条件：

- control 目录是应用私有且祖先链受控；
- 候选 FD identity 稳定；
- 目标 absent；
- renameat2 RENAME_NOREPLACE 或 linkat AT_EMPTY_PATH 经过目标文件系统验证；
- 安装后 fsync 目标目录并重新打开验证 identity/hash。

目标已存在时绝不覆盖。无法证明 absent-install 时保留现场并返回 RECOVERY_REQUIRED。

macOS 首版不实现推测性等价协议。

## 14. Task 8：诊断、恢复与用户出口

### 14.1 启动隔离

启动先读取 config 中已注册项目列表，再逐项目只读检查。

一个项目失败时记录 open_state 与稳定错误码，不放入可写 connection cache。其他项目继续启动。

全局 config、data root 或 ConfigLifecycleLease 失败仍阻止服务监听。

### 14.2 API

固定路由：

- GET /api/projects/by-name/:name/diagnostics；
- POST /api/projects/by-name/:name/diagnostics/recover；
- POST /api/projects/by-name/:name/diagnostics/export。

不提供未注册路径参数、importId、bundle picker 或任意文件系统路径输入。

GET 必须只读，不创建目录、candidate、checkpoint、event 或 SQLite journal。

POST recover 请求必须携带 GET 返回的 snapshot。服务端取得 writer lease 后从头检查；现场变化返回 RECOVERY_SNAPSHOT_STALE。

允许的 action：

- recover_transaction；
- recover_v1_publication；
- adopt_same_path_identity。

### 14.3 diagnostics DTO

返回白名单字段：

- state 与 stable reasonCode；
- protocol/backend/schema；
- trigger version、expected/project_meta/observed triggerSetDigest；
- dbIdentity 与 expectedIdentity；
- projectInstanceIdSha256；
- currentSeq 与 expectedSeq；
- ControlStore tail/checkpoint/event 摘要；
- integrity/FK 状态；
- platform capabilities；
- canAutoRecover；
- canAdoptIdentity；
- recommendedAction；
- snapshot。

禁止返回：

- 数据库原始字节；
- SQL、参数或查询结果；
- 章节、正文、大纲、设定、修订全文；
- prompt、聊天或 provider payload；
- API key、header、绝对用户目录；
- 未经白名单投影的 ControlStore payload。

### 14.4 export

导出目录固定为 db.getExportDir。

服务端生成 UUID opaque 文件名，不接受客户端路径或文件名。

诊断包可以在用户主动导出时计算当前文件 SHA-256；该 hash 只用于排障和现场识别，不成为 shutdown、checkpoint 或 adoption 的授权依据。

### 14.5 RecoveryNotice

项目 open_state != ready 时，点击项目不进入编辑器，而显示：

- 当前不能安全打开的说明；
- 本地化原因；
- 尝试自动恢复；
- 条件成立时的确认 identity adoption；
- 导出诊断包；
- 不要删除或覆盖现场的提示。

恢复成功后重新拉取项目列表和 diagnostics。失败或取消时保留现场。

### 14.6 稳定错误码

| code | 语义 | HTTP |
|---|---|---:|
| CONFIG_DATABASE_BUSY | config 被其他进程持有 | 423 |
| PROJECT_WRITE_BUSY | 项目 writer lease 竞争 | 423 |
| RECOVERY_REQUIRED | 现场无法自动唯一判定 | 409 |
| RECOVERY_SNAPSHOT_STALE | GET 后现场变化 | 409 |
| PROJECT_IDENTITY_REBIND_REQUIRED | 同路径新 identity，需要确认 | 409 |
| PROJECT_SCHEMA_TOO_NEW | 项目 schema 高于当前构建支持上限，必须使用更新版本 | 409 |
| NATIVE_ACTIVATION_DISABLED | 当前构建不允许激活 | 409 |
| NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED | native 项目不支持换根 | 409 |
| DURABILITY_UNSUPPORTED | 当前平台/路径能力不足 | 422 |
| CONTROL_STORE_PROTOCOL_UNSUPPORTED | writer 不支持 bounded 或更高 ControlStore protocol | 409 |
| CONTROL_STORE_CORRUPT | ControlStore metadata/digest/reference 不符合 exact contract | 409 |
| CONTROL_STORE_FENCED | 当前 facade 在持久化不确定后已隔离 | 503 |
| CONTROL_CHECKPOINT_BLOCKED | Task 6 empty/no-clean-basis 或 50% epoch-filter cap 无法构造安全 checkpoint；Task 7 hard admission 无 current clean job | 503 |
| SERVICE_SHUTTING_DOWN | sidecar 正在退出 | 503 |
| STORAGE_UNAVAILABLE | close/release disposition 不明 | 503 |

未知内部异常由最终 JSON middleware 变成 INTERNAL_ERROR，不返回 HTML 或 stack。

## 15. 桌面 shutdown 状态机

状态固定为：

running → quiescing → draining → closing → complete

异常终态是 failed。用户取消只允许发生在 closing 之前。

规则：

- quiescing 后拒绝新 mutation，但 listener 保持绑定，以便取消能恢复；
- draining 等待队列并补齐协议 terminal；
- cancelling 成功后恢复 admission、timer 和新的 service epoch；
- closing 才关闭 listener、connection 和 lease；
- complete 必须包含 childPid、attemptSeq、outcome = clean；
- close/release unknown 只能 failed；
- Tauri 只终止自己的 owned child；
- 无 heartbeat 不能自动判死，soft deadline 只改变 UI。

shutdown 不输出 snapshotCreated 或 restoreBasisCreated，因为本协议不在退出时创建备份。

## 16. 性能验收

### 16.1 权威阈值

3,000 章 fixture：

- native durability transaction p95 < 500 ms；
- 项目保存端到端 p95 < 300 ms；
- 每组 2 次不计入结果的 warm-up + 20 次 measurement，采用 nearest-rank p95，并报告全部样本、p50/p95/max；
- fresh 与 aged ControlStore 分开报告。

该方法与 l1-benchmarks.md 当前权威记录一致。后续若调整样本数或分位数算法，必须在同一修订中同步设计、实施计划、benchmark 文档与测试，不能保留两个版本。

### 16.2 八段计时

每次保存必须记录：

1. queue/lease wait；
2. manuscript.source append；
3. sqlite.tx.prepared append；
4. BEGIN + preflight；
5. 业务 DML + seq/gate；
6. SQLite COMMIT；
7. committed terminal append/post-check；
8. API/client end-to-end remainder。

八段之和必须能与总 wall-clock 核对。不能只报告 SQLite COMMIT。

### 16.3 aged history

使用 0、10,000、100,000 个已终结事件的 fixture。

证明：

- append 读取的 ControlStore 文件数不随已 checkpoint 历史增长；
- maintenance checkpoint 时间单独报告；
- 普通保存不做整库 hash；
- shutdown 时间与数据库大小无整库扫描相关性。

### 16.4 seed 与批量操作

新项目 seed 必须只产生一个项目级外层事务、一组 source/prepared/terminal。

禁止按章节逐行制造 ControlStore publication。

## 17. 测试与故障注入

### 17.1 前置基础

- ConfigLifecycleLease 双进程竞争和强杀接管；
- v1 terminal 前后 identity/hash/predicate 变化；
- SQL guard row-value UPDATE、plain INSERT 和绕过形状；
- durability metadata/gate/trigger DDL 的业务写入旁路全部被 runtime authorization 拒绝；
- production JSON error；
- token_usage 副作用隔离；
- close/release operational error 与 disposition unknown；
- D9 双实例、伪 3001、nonce 交叉；
- D10 取消、等待、正常退出和 emergency exit。

### 17.2 native transaction

至少覆盖：

- source 后强杀；
- prepared 后强杀；
- BEGIN 后强杀；
- 业务 DML 中强杀；
- seq 更新后强杀；
- gate 清空前后强杀；
- COMMIT 前后强杀；
- terminal append/install/tail 前后强杀。

每个点都断言 before 或 after，无第三种业务状态。

另用外部 SQLite writer 持有 reservation 覆盖 BEGIN IMMEDIATE 失败：断言 connection 仍为 autocommit、实现不调用 ROLLBACK、业务 DB 未被本次尝试触碰，并精确追加 begin_not_acquired terminal。一次有界重试最多产生两组 source + prepared + rolled_back；持续 busy 后停止重试、草稿保留，aged checkpoint 仍保持日志有界。事务已开始后的 preflight 失败则必须命中 transaction_rolled_back 分支。

### 17.3 activation 与降级

- off 构建对用户 root 零 activation 写入；
- 每种编译产物的 owned-child ready/build.info 必须报告预期 nativeActivationMode、source commit 和 target triple；环境变量、CLI、HTTP 与配置无法改变报告值或实际能力；
- packager 对 off/fixture_only/production 报告值做正负断言，fixture_only 进入 installer 或 production 包报告非 production 时构建失败；
- fixture_only 缺 marker、错误 root、复用 marker 全部拒绝；
- activation prepared 后每个 crash point；
- 高于 PROJECT_SCHEMA_VERSION 的项目在 migration/recovery/DML 前返回 PROJECT_SCHEMA_TOO_NEW 且文件、ControlStore 零修改；
- schema/backend/seq、trigger version 或 expected/project_meta/sqlite_schema digest 任一不一致都 fail-closed；
- migration schema audit 对 generator 未登记且不在 internal/read-only allowlist 的业务表失败；
- v0.0.7-v0.0.9 的表/DML 矩阵由 production canonical generator 派生，全部业务 DML 被拒绝，关闭旧进程后项目数据库与 ControlStore 逐字节不变；
- 用户可从任意 clean schema 10 项目直接升级，不要求中间版本 readiness。

### 17.4 checkpoint

- checkpoint candidate、install、tail 前后强杀；
- 多 successor、coveredDigest 不符、tail 落后/超前；
- 4,096/8,192 与 16/32 MiB 边界；
- 100,000 已终结事件后 append 成本有界；
- checkpoint 中不存在 formalSha256；
- shutdown 不触发低于阈值的 checkpoint。

### 17.5 identity adoption

- same path exact copy 新 inode可提示；
- seq、instance、schema、backend、gate、trigger version/digest 三方比对任一不符拒绝；
- integrity/FK 失败拒绝；
- 未终结 transaction/activation 拒绝；
- path/dbKey 变化拒绝；
- GET 零修改，POST stale snapshot 零修改；
- UI 明确不承诺字节相同。

### 17.6 Task 8

- 三种 v1 现场：可前滚、可回滚、第三种；
- native seq before、after、第三种；
- 单个坏项目不阻止健康项目；
- diagnostics/export 无正文和绝对路径；
- RecoveryNotice 恢复、取消、失败、刷新和无障碍；
- reserved project name 不与路由冲突；
- data-root 中存在 native 项目时迁移命令零修改拒绝。

### 17.7 平台与性能

- Windows 编译 sidecar 的真实 SQLite/VFS；
- NTFS VM 各 crash point hard reset；
- Linux 指定文件系统的 FD/no-clobber/fsync；
- macOS capability false；
- fresh/aged 八段计时；
- shutdown 大库无全盘 hash。

installer、tag、release 只属于完整 L1 production 候选的最终交付轨；必须在 Stage
A-C 的实现、性能、降级和平台门禁通过，并再次获得用户明确授权后执行。普通开发
构建继续报告 activation mode = off，Stage B 不接用户 data root 或生产项目打开路径。

## 18. 实施顺序

### 阶段 A｜完成 Task 8 兼容基础与本地验收

实现 ConfigLifecycleLease、v1 terminal 修正、SQL guard、JSON error、Task 8、D9 和 D10。

native activation 固定 off。完成服务端、客户端、桌面和手工测试后记录本地验收；
不在此阶段自动执行 installer、tag 或 release，也不把发布作为 Stage B/C 前置。

该版本的 packaged sidecar 必须通过 nonce 认证的 ready/build.info 报告 off。它不是 bridge；用户无需安装或打开每个项目。

### 阶段 B｜NativeProjectStore 与有界 ControlStore

实现 bun:sqlite facade、transaction 事件、commit seq、gate/trigger、checkpoint 和 aged-history 测试。

生产 wiring 仍关闭。测试使用 direct fixture store，不改用户 data root。

### 阶段 C｜fixture 激活、adoption 与平台证据

实现 activation prepared/activated/aborted、fixture_only marker、same-path adoption、downgrade negative control、平台 crash matrix 与八段性能；fixture sidecar 必须报告 fixture_only。

该阶段不得发布 fixture 二进制。

### 阶段 D｜production 激活候选与获授权后的 native release

从通过阶段 A-C 的同一 source commit 构建 production activation binary，要求 packaged sidecar 报告 production，再执行完整 installer smoke、临时用户 profile 激活/恢复、升级/降级负测和手工验收。

不要求与 fixture 二进制同一字节，也不为弥补这一点引入 runtime 签名授权。

全部门禁通过后才具备发布资格；实际 installer、tag、release 仍需用户明确授权。
发布后仍不支持 native data-root migration。

## 19. 完成定义

只有同时满足以下条件，延期工作才可标记完成：

- Task 8 服务端、前端、诊断导出和用户恢复入口已经实现并通过本地验收；
- ConfigLifecycleLease 覆盖所有 config writer 的完整生命周期；
- v1 terminal、SQL guard、JSON error 和遥测副作用缺口关闭；
- D9 单实例、动态 endpoint/nonce 和 owned-child shutdown 通过编译产物验收；
- D10 不再固定等待后强杀，且 shutdown 不计算整库 hash、不强制 checkpoint；
- NativeProjectStore 不再使用 sql.js 整库候选发布；
- Task 4 exact crash matrix 的每一行都由真实 child-process strong kill 触发，并唯一收敛到
  下表的 before 或 after；不得用 throw 模拟进程崩溃，也不得漏掉 Task 3 的九个冻结点；
- ControlStore append 对已 checkpoint 历史保持有界；
- schema 11 gate/triggers 阻止真实旧版本业务 DML；
- clean schema 10 项目可直接升级，不要求 bridge、cohort 或 readiness；
- off、fixture_only、production 三种编译期 activation mode 无 runtime 旁路；
- packaged sidecar 通过 nonce 认证的 ready/build.info 报告编译模式、source commit 和 target triple，且 smoke 结果与目标包类型一致；
- schema 高于当前支持值时在 migration/recovery/DML 前 fail-closed 并给出更新版本出口；
- canonical trigger generator、project_meta digest 与 sqlite_schema observed digest 三方一致，generator 未登记业务表和旧版本 DML 字节变化测试均会失败；
- same-path identity adoption 只在用户确认和协议一致性检查后发生，并明确不保证字节相同；
- native 项目存在时 data-root/path 迁移零修改拒绝；
- Windows/Linux/macOS 平台能力按真实 evidence 分别报告；
- native transaction p95 < 500 ms，端到端保存 p95 < 300 ms，八段耗时可核对；
- 单个坏项目不阻止健康项目与服务启动；
- busy、recovery、unsupported 和 shutdown 错误均为稳定 JSON/可理解 UI；
- server、client、typecheck、lint、sidecar、桌面与手工验收全部通过；
- 原计划和进度文档只按实际实现状态更新，不因本设计完成而提前标记 Task 6/8 完成。

Task 4 完成定义中的 exact crash matrix 为：

| strong-kill boundary | recover 结果 | 唯一稳定态 |
|---|---|---|
| caller 在 durable source post-check 后强杀 | `source_pending`；caller 追加 exact abandoned 后 clean | before；无 prepared/transaction terminal |
| `NATIVE_TX_AFTER_PREPARED_POSTCHECK` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_BEGIN_ACQUIRED` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_GATE_INSERT` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_BUSINESS_CALLBACK` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_SEQ_CAS` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_GATE_DELETE` | recovered `rolled_back` | before |
| `NATIVE_TX_BEFORE_COMMIT_INVOKE` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_COMMIT_RETURN` | recovered `committed` | after |
| `NATIVE_TX_BEFORE_TERMINAL_APPEND` | recovered `committed` | after |
| terminal append 的 `CONTROL_STORE_APPEND_BEFORE_PUBLISH` | candidate 未安装；recovered `committed` | after |
| terminal append 的 `CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC` | 已安装 exact terminal；clean、不得重复 terminal | after |
| Task 4 crash-only `NATIVE_TX_AFTER_TERMINAL_POSTCHECK` | clean、不得重复 terminal | after |

每行恢复后都必须精确断言业务 before/after、canonical TEXT seq、空 gate、ControlStore 唯一
successor/terminal 及无重复 terminal。`NATIVE_TX_AFTER_TERMINAL_POSTCHECK` 只允许 strong-kill
action，不得提供会抛错并伪造 commit uncertainty 的普通 fault action。

## 20. 当前实施状态（2026-08-12）

本设计已获用户确认并进入实施。Stage A 执行计划见
`../plans/2026-08-10-l1-durability-stage-a-compatibility-release.md`，实际验收
账本见 `../plans/l1-stage-a-acceptance.md`。

Stage A Task 1–10 的代码、聚焦测试、独立复审和本地编译产物验收已经完成。
compiled sidecar、RecoveryNotice 真实 UI、WebView2 CDP Desktop 生命周期矩阵均已
通过；`slow_drain_cancel` 已按零生产异步 admission 的结构性合同闭环。installer、
tag、release 未获授权且保持 `NOT_RUN`，但不阻塞 Stage B/C。

第 6 节中“当前仓库不存在 recovery-diagnostics.js、RecoveryNotice.tsx”等
文字记录的是 2026-08-10 的设计时基线，不再代表当前仓库清单；当前实现与
证据事实以 acceptance 账本为准。

当前开发主线已经完成 Stage B Task 1–7 correctness；权威执行计划见
`../plans/2026-08-11-l1-durability-stage-b-native-project-store.md`，验收账本见
`../plans/l1-stage-b-acceptance.md`。Task 4 crash recovery、Task 5 bounded tail、Task 6
checkpoint/GC 的既有提交与复审事实保持不变。Task 7 bounded native checkpoint integration
由提交 `bef7445` 完成：checkpoint reauth、absolute active suffix、retry reset、Bloom 128、
stale job 零写及 shutdown correctness 均闭环。fresh verification 为 aged `19/19`、native
`84/84`、Task 6 control+checkpoint `302/302`、coordinator+shutdown `76/76`、shutdown
`13/13`；最终总审 **APPROVE**，Critical 0、可复现数据损坏风险 0。

private `activeEpochObservations` 没有新增运行时 observation seam；runtime 只证明
membership/interval/count/Bloom 后果，一次静态审查证明顺序、exactly-once lowercase push、
freeze 与 same-private-array forwarding。internal native diagnostics 保持 `DEFERRED`，native
benchmark 保持 `NOT_RUN`。真实 mode-off sidecar 构建与 authenticated smoke 已通过，现有
build-sidecars 合同测试 `10/10`；但冻结计划要求的 fixture event-type binary-token 形式门禁
仍未满足，安全审查确认 testing factory/verifier 不在 graph、Critical 0、authority leak 0，
本轮不为该非安全关键 token 重构核心 ControlStore。

production `db.js` 仍是 schema 10，production factory/open/write wiring 与 native activation
保持 off。Stage C/D、旧版本 DML 负控、性能与平台矩阵继续 `DEFERRED`；Windows installer、
Linux、macOS、push、tag 和 release 为 `NOT_RUN`。既有性能重跑仍超过 500/300 ms 原始阈值，
不得宣称性能或完整 L1 已完成；第 19 节完成定义保持未满足。
