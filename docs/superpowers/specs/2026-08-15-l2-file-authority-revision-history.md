# L2 文件权威层规格修订历史

对应主规格：[L2 文件权威层规格（第 2.12 版）](./2026-08-15-l2-file-authority-spec.md)

本文保留主规格原 §19 编号，记录第 2 版至第 2.12 版的修订、评审与证据演进。本文仅用于审计和设计溯源；实施约束、验收标准与完成定义以主规格 §1–§18 为准。

## 19. 第 2 版修订清单

| # | 位置 | 修订 |
|---|---|---|
| 1 | 第 4 节 | 章节文件拍平；卷降为索引文件；受控树固定三目录五形状 |
| 2 | D5、4.4 | 新增第三条简化：卷归属只由索引承载，sidecar 删 `volume_uid` |
| 3 | 4.3 | `unassigned.json` 恒存在，取消「缺失等价于空」的歧义 |
| 4 | 4.6 | 四种 JSON 均带 `format_version`；新增 `MANUSCRIPT_FORMAT_TOO_NEW` |
| 5 | D6、5.1 | 受控树对象改按形状分类；非受控残留不阻断；孤儿阻断但有出口（分类法与出口形式已由 19.1 第 1、2、3、8 条取代） |
| 6 | 5.2 | 硬链接规则改为「链接计数必须为 1」 |
| 7 | 5.3 | 新增云同步目录检测与引导，兑现上游范围第 8 节 |
| 8 | 第 9 节 | 两级 probe 改为 watcher 脏路径集合；新增自我事件对消、启动顺序、平台能力与降级模式 |
| 9 | 9.5 | 取消「每次写入前完全校验」，改为闭包 hash CAS |
| 10 | 10.1 | 移动章节闭包收敛为两个索引文件；删卷不涉及目录操作 |
| 11 | 10.2 | 固定恢复资产根路径 |
| 12 | 第 11 节 | 冲突 backup 落盘位置；与 `editor_snapshots` 的分工；dirty registry 可信度的诚实表述；对上游 L4 范围的修订声明 |
| 13 | D7、12.1 | 路由真值定在 `project_meta`，config.db 只留可重建缓存索引 |
| 14 | 12.1 | 删除 `migration_failed` 路由状态，消除无法离开的死状态 |
| 15 | 12.2 | 投影提交与路由切换合并为单次 candidate 原子发布 |
| 16 | 7.3、12.7、15.2 | 补齐 `UNIQUE(volume_id, num)` → 部分唯一索引的 DDL 例外 |
| 17 | 7.4 | 伏笔 overdue 改为 `>=`（可回退） |
| 18 | 9.3 | 外部 `status` 变化使提案转 stale（可回退） |
| 19 | 第 13 节 | 补数据根命令拒绝；说明 sqlite/files 两种删除语义并存的 UI 要求 |
| 20 | 第 14 节 | 定义 `EXTERNAL_CHANGE_CONFLICT` 与 `PROJECTION_STALE`；补三个新码 |
| 21 | 1.1 | 新增 L2 前置门禁与当前状态，并把 L1 §19 拆成两级门禁 |
| 22 | D3、4.5 | 补 `U+0000` 正文与 `chapters.content` 字节等价的冲突处理 |
| 23 | 8.1 | 说明 L2 的 ManuscriptService 收口范围比 L1 大一圈 |

### 19.1 第 2.1 版补丁（同日评审）

第 2 版引入的四分法、就地出口与迁移改写又带出八个缺陷，其中两个是第 2 版自身的回归。逐条修正如下：

| # | 级别 | 缺陷 | 位置 | 修正 |
|---|---|---|---|---|
| 1 | P0 | 分类谓词对全部形状套用「必须被引用」，把 `manuscript.json` 与 `unassigned.json` 判成孤儿，项目一打开即自锁；journal 候选也没有合法归属，与发布协议直接冲突 | D6、5.1、5.2、4.6 | 谓词按角色拆开，两个结构根不需要被引用且缺失即 `MANUSCRIPT_FILESET_INVALID`；新增第三类 journal 候选（归属判定已由 19.2 第 1 条收紧） |
| 2 | P0 | **第 2 版回归。** 外部创建检测被改为按孤儿性判定，外部同时补齐资源文件与索引引用即可绕过 | D6、9.3 | 判定谓词回到投影新颖性：UID 在投影中既无活跃行也无 tombstone 行即为外部创建，与是否被索引引用无关；取 tombstone 入判据以保住同 UID 复活 |
| 3 | P1 | 孤儿隔离是未纳入 journal 的跨目录多文件移动，崩溃会留下半套资源 | 5.1.2、7.1、3.1、14 | 改为就地标记：写入持久忽略名单，随投影事务发布，零文件副作用 |
| 4 | P1 | 15.4 首条验收要求「修改后绝不返回旧 generation」，与 9.1 承认的事件投递延迟不能同时成立 | 15.4 | 以「事件进入脏路径集合」为同步点重述，并显式声明不断言「下一次读取立即可见」 |
| 5 | P1 | 冲突 backup 被定位在 FilePublicationJournal 目录下，而冲突时点可能不存在该 journal；无终态、无 GC | 11.1、10.2 | 新增 DraftConflictJournal，独立资产根、四态状态机、`archived` 唯一可回收、崩溃恢复不自动选边 |
| 6 | P1 | UID 冻结时点三处不一致；`files_published` 后「回滚」能否转中止无定义 | 12.2、12.4、12.6、12.8 | UID 在 `migration_reserved` 落盘时冻结，preflight 改为校验；中止边界统一为 `activation_intent` 之前且 child 收敛到完整 files before |
| 7 | P1 | L1 性能既是开工硬门禁又被 L2 后文允许延期 | 15.7、16.1 | 定为硬门禁：删除 L2 侧「L1 已批准延期」措辞，16.1 的延期条款限定为只适用于 L2 自身基准 |
| 8 | P1 | **第 2 版回归。** 删除了第 1 版的大小写折叠检查，并把非小写 UUID 文件当成无害残留；在大小写不敏感文件系统上会造成同一文件被双重处理、规范路径写穿 | 5.1.1、5.2、4.6 | 枚举时用 OS 实名与规范推导名逐字节比较，不一致即硬失败；恢复折叠重复检查，且不按平台分支 |

### 19.2 第 2.2 版补丁（同日第三轮评审）

第 2.1 版的四分法、就地忽略与新 journal 又留下五处缺口：

| # | 缺陷 | 位置 | 修正 |
|---|---|---|---|
| 1 | 「无主候选按 journal 证据删除」在 journal 根本不存在时无证据可依，等于授权无证据删除外部文件 | D6、5.2、15.1 | 三类归属收紧为 `journal_id` 必须对应真实 journal 记录；对不上的降为四类，永不删除 |
| 2 | 忽略名单恢复写入后，按投影重建索引会静默抹掉被忽略 UID 的索引条目，撤销忽略后还会退化成孤儿 | 5.1.2、7.1、7.3、15.1 | 被忽略 UID 作为不透明成员原样写回原容器末尾，稳定排序；忽略名单记录 UID、原容器与原引用状态 |
| 3 | 降级模式的「每次写入前完全校验」与 9.5「写入不执行完全校验」直接冲突 | 9.1、9.5 | 降级模式改为让全脏标记常置，不新增触发点；9.5 改写为「写入本身不触发完全校验」 |
| 4 | DraftConflictJournal 缺意图态、父子完成顺序和 `superseded` 终态，`backup_durable` 到终态之间有无记录的崩溃窗口 | 11.1、15.4 | 增两个意图态并绑定 child journal ID 与目标 generation；固定父子完成顺序；`superseded` 为保留 backup 的终态并带 `supersedes` 链 |
| 5 | 新项目没有既有数据库和 ControlStore，无法执行 route-fence，12.2 那句「使用同样的协议」按字面不可执行 | 12.2、12.9、15.5 | 新增 ProjectCreationJournal 独立协议，八步顺序、中止与恢复规则，路由键出生即为 `files` |

### 19.3 第 2.3 版补丁（同日第四轮复查）

第 2.2 版闭合了被忽略 UID 的普通索引重写，却仍未覆盖删除原容器；两个 journal 的所有权边界也各有一处会丢失唯一恢复证据。逐条修正如下：

| # | 级别 | 缺陷 | 位置 | 修正 |
|---|---|---|---|---|
| 1 | P1 | 被忽略章节 UID 虽会在普通重写时保留，但删除它所在的卷仍会连同唯一索引引用一起抹掉 | 5.1.2、10.1、14、15.1 | 含不透明引用的卷删除在文件副作用前失败；新增「转为未分卷」与「解除索引引用」两个显式 journal 化动作，并把索引 after 与忽略名单 after 绑定到同一 generation |
| 2 | P1 | `resolve_apply_intent` 在 child 未定时仍可被外部变化直接转成 `superseded`，父状态会掩盖未恢复的文件副作用 | 11.1、15.4 | 新增 `decision_ready`、decision epoch 与 `resolve_apply_aborted`；apply intent 必须先凭 child 证据收敛到 before 或 after，不能直接 supersede 或无事件回退 |
| 3 | P1 | ProjectCreationJournal 放在待删除的目标 ControlStore 内，中止时会删除自己的唯一创建身份、UID 退役与恢复证据 | 12.9、15.5 | 把唯一父 journal 移到目标项目之外的应用级创建控制根；中止只删除可证明归属的目标对象，父 journal 在耐久检查点前保留 |
| 4 | P2 | D3 与 4.5 已定义 `U+0000` 的投影例外，但 15.2 仍无条件要求 `chapters.content` 与 raw bytes 等价 | D3、4.5、15.2 | 验收显式排除该只读透传例外，并要求 content 置空、不可用标记、hash/word count/generation 正确且拒写零修改 |

### 19.4 第 2.4 版 Windows watcher 定稿实测

本版按用户决定只执行 Windows watcher 证据。实测前置已经完成，但结果否定了「Bun `fs.watch` 的丢失总会产生可用于置全脏的显式信号」这一关键假设，因此证据完成不等于第 9 节方案定稿。

| # | 位置 | 证据或缺口 | 修订 |
|---|---|---|---|
| 1 | 0、9.1 | 原定稿前置包含本版不需要的平台范围 | 定稿实测只覆盖 Bun 1.3.14 Windows x64 编译产物，不再等待其他平台证据 |
| 2 | 9.1 | 递归是否生效、事件是否合并、压力下是否丢失、原子替换事件序列均未实测 | 新增可编译探针与原始结果；递归及低速对照通过，同文件 2,000 次写入合并为 1 个事件，原子替换 20 次观察序列一致 |
| 3 | 9.1、15.4 | 高速不同路径事件可静默丢失，既没有 watcher error，也没有空文件名或其他溢出信号 | Bun `fs.watch` 的 Windows `manuscriptChangeNotification` 固定为 false；显式溢出处理不能替代能力负向评估，脏路径集合为空不再构成可信证明 |
| 4 | 16.1、18 | 原文无条件声称正常读取只需内存判断，但该前提只在通知能力为 true 时成立 | 性能结论改为条件式；Windows 默认激活必须先验证替代原语，或者另行批准并验收常置全脏降级模式 |

### 19.5 第 2.5 版 Windows 直接变化 feed 决策

本版不再把「丢事件是否不可避免」当作能力判据，而把判据改为「通知覆盖丢失是否能被显式检测并在 false-clean 之前锁存」。L2 v1 只解决运行期间的低延迟变化覆盖，进程未运行期间仍由启动完全校验负责。

| # | 位置 | 决策 | 修订 |
|---|---|---|---|
| 1 | 9.1 | Windows 默认原语 | 直接通过 `bun:ffi` 使用 `ReadDirectoryChangesW`；三个非递归目录各用独立句柄、OVERLAPPED 状态和 1 MiB 缓冲区，Bun `fs.watch` 退出权威链 |
| 2 | 9.1 | 能力语义 | 允许重复、合并和乱序；原生完成可取后，freshness gate 必须消费它或拒绝 clean，最终形成覆盖变化的 dirty 证据或锁存 `coverageLost`；静默 false-clean 才是能力失败 |
| 3 | 9.1、15.4 | 丢失检测 | 零字节成功完成、`ERROR_NOTIFY_ENUM_DIR`、解析或重新布防失败、句柄失效等全部先锁存再完全校验；只有成功完全校验可以清除 |
| 4 | 9.1、15.4 | 竞态闭合 | 完成后先取状态、再用另一缓冲区重新布防、后解析旧缓冲；启动先布防再扫描，并以 coverage-loss epoch 和事件序号阻止校验窗口 false-clean |
| 5 | 9.1、18 | 延后范围 | USN Change Journal 延后为启动与离线变化优化；它不替代直接 feed，也不替代能力失败后的完全校验 |
| 6 | 9.1、15.4、16.1 | 平台原语状态 | 直接 feed 已在 Bun 1.3.14 Windows x64 编译产物下通过强制溢出、freshness 同步、边界竞态、压力、原子替换和目录身份共八项矩阵；限定支持包络内的平台能力改为 true，生产集成后仍须重跑，且第 2.7 版另补适配器并发交错 |

### 19.6 第 2.6 版产品决定

第 2.5 版已经闭合 Windows 变化 feed，但第 17 节仍有三个会改变验收和用户流程的开放问题。本版按推荐值全部固定，不再把它们留给实施阶段临时决定。

| # | 位置 | 决定 | 修订 |
|---|---|---|---|
| 1 | 16.2、17、18 | 容量画像 | 10,000 章、2,000 卷、25,000 文件、1 GiB 等建议值转为 L2 v1 硬安全上限；活跃对象与 tombstone 合并计数，3,000 章用于正常性能，边界 fixture 用于正确性、资源控制和全量路径校准 |
| 2 | D4、12.1、15.5、17、18 | 迁移延期 | 用户确认前可反复延期且零副作用，继续完整 L1 路径；route-fence 进入 `migrating` 后普通入口和延期按钮全部阻断，只能按 journal 前滚、恢复、诊断或安全中止 |
| 3 | D4、15.7、16.1、17、18 | 性能门禁 | correctness 可合并为显式实验路径并诚实标记 `PERFORMANCE_DEFERRED`；普通项目保持 `sqlite`，三个正常 p95 与启动/刷新校准、进度、取消验收全部满足后才是 `DEFAULT_READY` 并默认启用 `files` |

### 19.7 第 2.7 版最终评审修订

第 2.6 版的产品决定已经清零开放项，但 Windows direct feed 的完成消费与快速读取之间仍有一个可观察竞态，另外四处实施契约无法验收或可能绕过安全出口。本版逐项闭合如下：

| # | 级别 | 缺陷 | 位置 | 修正 |
|---|---|---|---|---|
| 1 | P0 | completion 已被后台泵取得并重新布防、旧缓冲区尚未解析时，event 已 nonsignaled 且 dirty 仍为空，快速读取可返回旧投影 | 9.1、9.3、9.4、15.4、18 | 每个 handle instance 新增单调 `completionsObserved/completionsAccounted`，取得完成后先 observed，路径入集合或 loss 锁存后才 accounted；clean 必须在同一线性化快照中同时满足 event 未触发、armed、计数相等、dirty 为空且无 loss，并新增确定性交错验收 |
| 2 | P1 | 不共享 delete access 的目录句柄没有启停和拆除顺序，可能阻断创建/迁移中止并让 retired 项目继续锁目录 | 9.1、12.9、13、15.4–15.6、18 | feed 仅在成功终态后的活动 `files` 会话建立；固定 cancel、结清、关闭、释放 shared lease 的拆除顺序；退役先取得 exclusive feed-lifecycle 屏障，其他进程未退出时零副作用 busy；候选与 retired 永不持有 feed |
| 3 | P1 | ignored UID 既不属于 active 也不属于 tombstone，且“跳过文件”可被解释为跳过文件数与字节计量 | 5.1.2、7.1、9.3、15.1、16.2、17、18 | ignored 表兼作不可物理删除的身份账本并区分 active/revoked；身份并入生命周期上限，active ignored 文件仍计实名、文件身份、单文件大小、文件数与原始字节，撤销或删文件不释放 UID 容量 |
| 4 | P1 | “已分配或 retired UID 全局永不复用”依赖全文未定义的应用级耐久 checkpoint，无法实施和验收 | D2、12.6、12.9、14、15.5、18 | 改为 CSPRNG UUIDv4、reservation 前当前证据范围碰撞检查、落盘冻结与同 journal 重试复用；中止只在原 journal 标记 aborted，删除全局永久不复用和未定义 checkpoint 承诺 |
| 5 | P1 | 每项目三组系统内部缓冲区与六组用户缓冲区没有同时 armed 项目上限 | 9.1、15.4、16.1、18 | 固定 `MAX_ARMED_FILE_PROJECTS_PER_PROCESS = 1` 和约 9 MiB 名义预算；无槽项目常置全脏，切槽必须完整拆除旧 feed 并对新项目重新完全校验，且不声称具体系统池类型 |

### 19.8 第 2.8 版独立复审修订

独立 sub-agent 对第 2.7 版 SHA-256 `335A38D48CD9B21CEF8E26381ACF7ECB6E7AB41A0E1FE9C3D2C3988627043AF6` 做了全文复审，发现一个新 P0、六个 P1 与一个 P2。本版不把“已完成一次独立复审”等同于通过，而是逐项修正如下：

| # | 级别 | 缺陷 | 位置 | 修正 |
|---|---|---|---|---|
| 1 | P0 | dirty 被 refresher 取出后到 projection commit 之前，普通集合暂时为空，快速读取仍可能返回旧 generation | 9.1、9.3、9.4、15.4、18 | 原子建立 `refreshInProgress + refreshingDirty + refreshBaseGeneration` claim，commit 确定成功或自我事件已被当前 projection 覆盖前不清除；clean 纳入 claim，查询后另比对 generation/epoch，并增加 claim 到 commit 的确定性交错 |
| 2 | P1 | 无 direct-feed slot 的降级普通会话不持 shared lease，exclusive 不能证明没有其他使用者 | 9.1、13、15.4、15.6、18 | 所有普通 `files` 会话从 admission 到在途请求结束都持 shared manuscript-lifecycle lease，feed slot 只控制目录句柄；退役 exclusive 因而覆盖有槽与无槽会话 |
| 3 | P1 | 新增 shared/exclusive lease 没有规范锁键、Windows 原语、错误语义、强杀释放和锁序 | 9.1、12.8–12.9、13–16、18 | 固定 ControlStore 父目录的 canonical-real-path hash sibling 锁实体、`LockFileEx [0,1)` shared/exclusive 非阻塞协议、能力与错误映射、unlock/close 语义、固定锁序和双进程编译产物矩阵 |
| 4 | P1 | feed 启动无条件要求历史创建/迁移父 journal 成功终态，但成功 journal 可以合法 GC | 9.1、15.6 | 改为“父 journal 存在则必须成功终态，任何非终结父 journal 阻断”；合法 GC 后以 route、持久身份、物理绑定、generation 与首次完全校验为准 |
| 5 | P1 | active ignored 文件在完全校验后发生外部扩容或成员变化时可被增量路径直接跳过 | 5.1.2、7.1、9.3、15.1、15.4、16.2、18 | ignored 账本保存成员与容量 before；每次 dirty 重验全部规范成员、身份、单文件和总量并更新同 generation 容量快照，无法增量证明则全脏，外部超限现场保留并持续阻断 |
| 6 | P1 | project UID 碰撞扫描漏掉 MigrationJournal reservation，且其 GC 边界未定义 | 12.6、15.5、18 | 扫描所有当前注册 ControlStore 中仍存在的 migration reservation，扫描不完整 fail-closed；固定 aborted/activated journal 进入 L1 bounded GC 的谓词，并诚实声明 aborted GC 后只剩 CSPRNG 概率保证 |
| 7 | P1 | 普通新建章节/卷没有首个 asset intent 前的碰撞检查、UID 冻结和同请求重试复用 | 10.2、12.6、15.5、18 | 在 writer lease 与 freshness gate 后生成并检查 UUIDv4，完整 serializable assignment 作为 `stageAssets()` 输入并由 `assets_reserved` 绑定 UID、整数 ID/编号、路径与 logical request，此后不得重抽；晚到碰撞只按 journal 收敛或报定义错误 |
| 8 | P2 | accept projection 已提交、父终态未写时再次外部变化，会把已生效接受误记为 superseded | 11.1、15.4、18 | accept intent 绑定 before/target generation 与 raw hash；恢复先检查 projection，目标已提交必须先写 `resolved_accept_external`，只有 projection 仍为 before 且文件已变时才可 superseded |

### 19.9 第 2.9 版独立复验修订

独立 sub-agent 对第 2.8 版 SHA-256 `A7FE7594E33A8882067AD43F059B926424CA89DB3745EC3AFD0321715FA65A8C` 复验后确认第 19.8 节的原始一个 P0、六个 P1 与一个 P2 均已闭合，但另发现一个退役锁序 P1 和一个 reservation 命名空间 P2；第 2.9 版继续修正如下，并按现有复验结论定稿，不再要求修订后哈希的再次独立复验作为定稿门：

| # | 级别 | 缺陷 | 位置 | 修正 |
|---|---|---|---|---|
| 1 | P1 | 退役先持 writer lease 再排空本进程在途请求，会与已经 admission、尚未申请 writer 的请求互相等待 | 9.1、13、15.6、18 | 退役在 registry/config lease 下先把 controller 切为 `retiring` 并关闭新请求 admission，随后释放该 lease并无锁排空已经 admission 的请求，归零后重新取得 registry/config、复核并取得 writer；exclusive 竞争失败时零路由副作用恢复 controller，并增加 admission 到 registry/writer 之间暂停的确定性交错 |
| 2 | P2 | 保留期内 MigrationJournal 的“全部 reservation 参与碰撞”没有明确 chapter/volume 的命名空间与普通创建覆盖 | 12.6、15.5、18 | project reservation 进入全局项目 UID 集合，chapter/volume reservation 进入同一 L1 项目控制身份的对应种类集合；迁移和普通创建都扫描，枚举不完整 fail-closed，并增加成功/中止终态保留期注入测试 |

### 19.10 2026-08-17 L1 前置门禁记账调整

产品决定不再要求获取、运行或长期维护 v0.0.7、v0.0.8、v0.0.9 三个真实历史产物的 DML 负控矩阵，因此该矩阵从 L2 独立前置门禁与 Stage 0 实施任务中删除。schema 11/12 的 downgrade guard 本身不删除：可写表、INSERT/UPDATE/DELETE 与 expected trigger rows 继续由 production canonical generator 派生，使用无内部 capability 的版本无关 harness 验证全部拒绝、项目数据库与 ControlStore 零修改，并继续执行 expected/project_meta/sqlite_schema digest 三方一致检查。

### 19.11 第 2.10 版实施门禁调度精简

为避免在每个开发 SHA 上重复构建 production 证据平台和运行耗时 VM 矩阵，本版只调整门禁的执行时点，不降低产品合同：

- Task 1A 仅关闭 schema 11/native correctness 与现有 contracts 回归；L2 correctness 实施随后可以先行，但 `files` 保持显式实验入口，普通项目继续默认 `sqlite`。
- L1 native/save p95 仍是 `DEFAULT_READY` 硬门禁，只是与 L2 三项 p95 一起延后到最终 production source 验收，不再要求为此新增八段 production timing control protocol。
- 历史 Windows 13/13 与 19/19 作为开发基线；所有 L2 production source 和默认路由决定提交、冻结后，只对最终 SHA 做一次完整 VM 重绑定与 candidate/E2E/benchmark/desktop smoke。
- 删除通用 evidence publisher、build/execution receipt 与 attestation 平台的实施要求；最终证据沿用既有 reviewed-manifest trust boundary，并由独立 reviewer 核对原始日志、真实退出码和 SHA-256 后写入仓库账本。

### 19.12 第 2.11 版文件发布可执行性修订

本版不降低第 2.10 版的耐久、原子性或最终验收门禁，只把 Task 5 target physical identity、child parent pin 与 crash recovery 之间原本无法按顺序实现的合同收口为一条可执行路径：

- 可序列化 identity assignment 与唯一 closure 先冻结；随后严格按 `assets_reserved → create-new/fsync before copy 与 staged-after → merge identity/build target → target_reserved → create-new/fsync target asset` 执行。三类 asset 都位于与文章根同一 physical volume 的 recovery root；displaced-before 只预留 absent path/parent/predicate，绝不预建实体；Task 5 target 使用同一 staged-after identity，`prepared` 仍早于首个文章树副作用；
- 发布改为 verified no-replace 两步 relocate（before final → absent displaced destination，staged-after → absent final），displaced physical identity 只在第一步后产生并必须等于 before；协议显式承认并恢复 journal 控制的 GAP，第三方抢占永不覆盖；正常路径不在受控树创建 `.tmp`，D6 只保留历史或 manifest 明确记录的候选规则；
- `full` 在 `files_published` 后只按 exact projection disposition 前滚；`file_only` 在完整 pin 前只接受 parent durable child reservation、partial manifest、pin-absence 和 safe-abort intent，在完整 pin 落盘后（即使尚未 `prepared`）只接受绑定该 pin 的 opaque before/after intent；
- 新增 `rolled_back`、`assets_collected` 与 handle-bound verified delete；成功或 safe abort 按 exact partial/full manifest、child 终态、reservation/pin 和 no-reference 谓词回收。ProjectCreationJournal 中止还必须在目标 ControlStore 存在时收集 child assets、把 receipt/pin release 外存后才以 ControlStore-last 顺序删除目标并写 `creation_aborted`，避免最高 1 GiB recovery assets 无界泄漏或删除自己的唯一证据；
- Task 6 仍只实现窄 journal/publisher/platform boundary 与 focused crash tests；command→closure、真实 SQL/schema、父 journal 实现和产品接线继续分别留在 Task 7、Task 12/13 与 Task 14B。
- production 边界由零注入 factory 在单一 shared backend 上分别铸 read/writer capability；Store 永不获得 create/write/relocate/delete，clone/foreign/swap/production fake injection 全部 fail-closed，测试 fake 只走 test-only mint。

### 19.13 第 2.12 版冷恢复与恢复根修订

独立代码复审发现，第 2.11 版仍把每个 journal 的恢复子目录当作已存在事实，却没有 mkdir authority；同时未把副作用已发生但 parent fsync 未证明的 disposition，以及 `files_published` 后的文件再验证写成逐步硬门。第 2.12 版最小修正如下：

- 恢复资产只放在既有项目 ControlStore 根内唯一的长期 `<data>/control/manuscripts/<project_uid>/<project_instance_id>/file-assets/` 容器，使用扁平 `<journal_id>.<asset_name>`；Task 6 只为 exact plain non-reparse `file-assets` 保留根命名空间项，第 11.1 节的 `draft-conflict` 由 Task 11 另行安装为第二个精确保留容器，其他未知项仍 fail-closed。Task 12/13 在 child reserve 前唯一创建并绑定 ControlStore 根与 `file-assets`，Task 6/7 只 `OPEN_EXISTING`，不引入第五个 mkdir port或 per-journal 目录状态机；GC 只删已证明归属的叶文件，永不删容器或 ControlStore 根；
- full `prepared` 冷恢复只有 projection exact `base` 才能在零文章副作用后继续；`target | other | unknown` fail-closed。`files_published` 后提交 projection 或推进 parent 前必须重新证明 manifest 全成员完整 `AFTER`；
- `created | relocated | deleted = true` 后任何 postcheck、pinned-parent fsync、close 或 receipt 失败都保留为未决 durability disposition，重试不得仅凭路径外观升级为成功或终态；尤其 cold ABSENT 只有在已有绑定 exact identity 与同一 verified parent handle 的 `deleted = true, parentFsync = true` 回执时才可幂等，否则保持 `RECOVERY_REQUIRED`。parser 重新派生所有 final/recovery 路径与 input digest，不信任事件自报路径。
- Journal 构造器逐字节绑定实际 ControlStore directory/incarnation 与 project binding，final path 复用 Task 3 path authority；当前没有真实 legacy candidate producer，因此删除假想 candidate 事件 schema并让 L2 v1 `journalAuthority` deny-all，正向候选认领后移到 producer 与 exact manifest 同时出现的任务。
