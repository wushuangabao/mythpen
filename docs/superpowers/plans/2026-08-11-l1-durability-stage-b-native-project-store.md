# L1 Durability Stage B NativeProjectStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不接入用户项目和 production open wiring 的前提下，实现可直接测试的
`bun:sqlite` NativeProjectStore、schema 11 gate/trigger、native transaction 恢复协议
和有界 ControlStore，为 Stage C fixture activation 提供稳定底座。

**Architecture:** Stage B 只操作测试创建的临时 data root。`server/native/` 持有
schema contract、identity guard、SQL authorization 和 store；现有
`ProjectWriteCoordinator`/ControlStore 提供 lease 与事件证据。生产 `db.js` 继续使用
schema 10 + `SqlJsAtomicStore`，直到 Stage C activation 明确接线。

**Tech Stack:** Bun 1.3.14、`bun:sqlite`、CommonJS、Node/Bun test runner、现有
ControlStore、ProjectWriteCoordinator、fault injection 与 Windows/POSIX durability
primitives。

## Global Constraints

- 不执行 installer、tag、push 或 release；发布不是 Stage B/C 前置。
- 不修改真实用户 data root、config registry 或默认 `%USERPROFILE%\.mythpen-control`。
- 不把 `server/db.js` 的 `PROJECT_SCHEMA_VERSION` 从 10 改为 11，不把 native store
  接入生产项目 open/write 路径。
- Stage B 不实现 schema 10 用户项目 activation、`fixture_only`/`production`
  activation、identity adoption、data-root migration 或旧版本二进制负控。
- 所有 native fixture 必须在测试新建的临时 root 中；普通构建继续报告
  `nativeActivationMode=off`。
- schema 11 不改变领域字段或 REST 语义，只增加 durability internal table、保留键和
  downgrade triggers。
- trigger manifest、安装、audit、digest 和后续降级探针必须共享一个 production
  generator；测试不得维护第二份业务表清单。
- native 普通提交不计算整库 SHA-256；ControlStore event 不保存正文。
- checkpoint 只为 `native-sqlite-v2` 的显式 bounded store 启用；现有 sqljs-v1
  ControlStore 默认行为和磁盘字节不变。
- NativeProjectStore core 对空 ControlStore 一律拒绝。Stage B direct fixture 只能通过
  不进入 production module graph 的 testing factory 和精确 fixture genesis 打开；不得把
  “schema 11 + seq 0”本身当成 activation/creation evidence。
- 新代码按 TDD 提交；每个任务先观察目标 RED，再做最小 GREEN，并接受独立审查。

## Frozen Stage B Contracts

### Schema 11

- `NATIVE_PROJECT_SCHEMA_VERSION = 11`
- `NATIVE_DURABILITY_BACKEND = 'native-sqlite-v2'`
- `NATIVE_TRIGGER_VERSION = 1`
- gate 表：

```sql
CREATE TABLE "_durability_write_gate" (
  "gate_id" INTEGER NOT NULL PRIMARY KEY CHECK ("gate_id" = 1)
) WITHOUT ROWID;
```

- gate 稳定态为 0 行；native 外层事务内精确插入 `(1)`，提交前精确删除。
- 可写表 manifest 精确包含 18 表：
  `project_meta`、`volumes`、`chapters`、`characters`、`chapter_characters`、
  `world_entries`、`project_genres`、`sidebar_items`、`foreshadows`、`memories`、
  `character_relations`、`science_entries`、`timeline_events`、`clue_board`、
  `token_usage`、`chat_sessions`、`chat_messages`、`chapter_revisions`。
- 每表生成 `INSERT/UPDATE/DELETE` 三条 BEFORE trigger，共 54 条；名称固定为
  `_mythpen_downgrade_guard__<table>__<operation-lowercase>`。
- trigger body 固定为：

```sql
CREATE TRIGGER "<name>" BEFORE <OPERATION> ON "<table>"
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM "_durability_write_gate" WHERE "gate_id" = 1
)
BEGIN
  SELECT RAISE(ABORT, 'MYTHPEN_DURABILITY_WRITE_GATE_CLOSED');
END;
```

- canonicalizer 将 CRLF/CR 转 LF，删除注释和无语义空白，严格 token 化 quoted
  identifier/string/number/operator，固定 SQLite keyword 大写，token 以单个 ASCII
  空格连接；NUL、未闭合 token、多语句或未知结构直接拒绝。
- canonical record 固定为 `{name,table,operation,sql}`，按 trigger name 的 UTF-8
  bytes 排序；顶层为
  `{"format":"mythpen-downgrade-trigger-set-v1","triggers":[...]}`，对无缩进 UTF-8
  bytes 做 SHA-256，输出 lowercase hex。
- 三方验证为代码 expected digest、`project_meta.durability_trigger_set_digest`、
  `sqlite_schema` observed digest；任一缺失、额外 reserved trigger 或语义变化均拒绝。
- schema 11 完成态精确包含以下六个唯一保留键：
  - `schema_version='11'`；安装时必须由唯一的 `schema_version='10'` 单行 CAS 更新，
    `changes===1`；
  - `project_instance_id=<原 v10 UUID>`；安装前验证唯一、格式合法，安装中原样保留，
    不生成、不更新；
  - `durability_backend='native-sqlite-v2'`；
  - `durability_commit_seq='0'`；
  - `durability_trigger_version='1'`；
  - `durability_trigger_set_digest=<code expected 64 lowercase hex>`。
  四个 `durability_*` 键安装前必须均不存在，只能各 INSERT 一行并验证
  `changes===1`；最终逐键验证唯一、格式和值，不允许 REPLACE/UPSERT 掩盖旧状态。

### Stage B fixture genesis

- fixture schema 安装成功后，在空 ControlStore 中只允许追加一条
  `sqlite.native.stage_b.fixture_genesis`。其 exact payload keys 为
  `{version,eventId,dbKey,projectInstanceIdSha256,createdAt,ownershipHash,connectionEpoch,
  fixtureRunId,schemaVersion,backend,finalSeq,gateEmpty,triggerVersion,triggerSetDigest,identity}`；
  `version=1`、eventId/connectionEpoch/fixtureRunId 三者均为 UUID-v4、所有 hash 为
  64 lowercase hex、`schemaVersion=11`、
  `backend='native-sqlite-v2'`、`finalSeq=0`、`gateEmpty=true`，identity 精确为
  `{dev:<decimal string>,ino:<decimal string>}`。
- helper 必须在同一 writer/lifecycle authority 下 append、重读并 post-check genesis，且把
  genesis digest 与不可序列化的 testing authority 保持在进程内。数据库谓词与 payload
  任一不符即销毁 fixture，不尝试修补。
- `server/testing/native-stage-b-store.js` 是唯一接受该 genesis 的 factory；它向 core
  注入 closure-private verifier 函数 capability，但不导出该函数或 token。普通
  NativeProjectStore 入口对
  空 evidence 和 fixture genesis 都返回 `NATIVE_ACTIVATION_DISABLED`。Task 8 的 build
  graph/binary scan 必须证明 testing factory、event type 和 fixture authority 未进入
  sidecar。Stage C 只能新增 production activation/creation verifier，不能复用此 genesis。
- testing factory 始终只认证第一条 exact genesis、fixtureRunId/genesisDigest 与 helper-owned
  root。`databaseSha256` 只证明 genesis-only fixture 的首次打开；一旦存在合法 native suffix，
  clean reopen 改由 core 的 exact suffix 状态机与当前 DB live predicates 授权，不再要求数据库
  字节仍等于 genesis 初始 hash。factory 不得因此接受未知 suffix，也不得新增 source/public
  authority 创建能力。

### Native facade

```js
createNativeProjectStoreCore({
  databasePath,
  controlStore,
  dbKey,
  projectInstanceIdSha256,
  ownershipHash,
  assertWriterLease,
  admissionVerifier,
  identityApi,
  sqliteFactory,
})
```

公开能力只包含 `readAll()`、`readGet()`、`executeTransaction()`、`recover()`、
`checkpoint()`、`close()`、`fence()` 和只读 `connectionEpoch/state`。raw Bun Database
不对外暴露。`executeTransaction(input, callback)` 给 callback 一个受 epoch 和内部
capability 约束的 statement facade；durability internal SQL 不能从业务 callback 调用。
transaction operation 必须同步且独占：callback 返回或抛错后 statement facade 立即 stale；
Promise/thenable 一律按事务失败回滚。同一 store 在 operation 期间的外层 read、递归
transaction、recover/checkpoint、close/fence 均须在零额外 SQLite/ControlStore 副作用下拒绝。

factory 必须先用 admission、ControlStore exact suffix/tail 和只读文件 identity 把现场分类，
不得为了分类而打开 SQLite：

- clean basis 直接打开为 `state='active'`，生成一个完整历史中未使用的 UUID
  `connectionEpoch`；
- source-only 和 prepared 返回不持有 SQLite connection 的 cold facade，固定
  `state='recovery_required'`、`connectionEpoch=null`；
- cold facade 只允许 `recover()`、`close()`、`fence()` 和只读 getters；read、transaction、
  checkpoint 都以 `RECOVERY_REQUIRED` 零 SQLite、零 ControlStore 副作用拒绝。

public fence state 沿用 Task 3 的 exact `state='fenced'`。cold `fence()` 不打开 SQLite；它只在
guard 与全部已持有 resource 的 disposition 可证明后进入 `fenced`，否则进入
`disposition_unknown`。`logical fence` 仅是内部动作术语，不是第二个 public state 值。

`recover()` exact return union 固定为：

```js
{ status: 'clean', finalSeq, connectionEpoch }
{ status: 'source_pending', sourceDigest, finalSeq, connectionEpoch: null }
{
  status: 'rolled_back' | 'committed',
  preparedDigest,
  terminalDigest,
  finalSeq,
  connectionEpoch,
}
```

clean recover 幂等且不得轮换 epoch。source-only recover 不打开 SQLite、不 append，调用者
（Stage B crash harness；未来为 ManuscriptService）必须以原 source connectionEpoch 和
source digest 为 CAS tail 追加 reasonCode=`superseded|cancelled` 的 exact abandoned；store
永不代写 abandoned。同一个 cold facade 只接受该 exact successor，随后重新验证并打开为
active，同时生成历史未使用的新 epoch。prepared recovery 只有在受控 SQLite recovery 和
全部 live predicates 通过后才 mint fresh epoch，并以它追加 recovery terminal；terminal
post-check 前不得转 active。

`admissionVerifier` 是必填、不可序列化的函数 capability。core 在打开 SQLite 前以冻结
ControlStore evidence 调用它，并要求返回 exact `{basisKind,basisDigest}`；缺失、非函数、
抛错或返回额外/错误字段均拒绝。Stage B testing module 在自己的 closure 中构造只接受
精确 fixtureRunId/genesisDigest 的 verifier；普通入口未来只能传 Stage C production
activation/creation verifier，不能传 fixture verifier。

连接必须验证：`journal_mode=delete`、`synchronous=extra`、`foreign_keys=1`、
`busy_timeout=100`、autocommit、schema/backend/seq/gate/trigger 三方状态。测试必须回读
100 ms，并对第一次 busy 和调用者发起的第二次 attempt 分别设置有容差的耗时上界，
禁止退回 5 秒阻塞。

### Native transaction evidence

Native event 顶层只允许
`{seq,type,payload,prevDigest,digest}`；legacy v1 event parser 继续允许其既有可选
`afterPredicate`，bounded reader 不得据此收窄或改写旧事件。Native event 禁止
`afterPredicate`。以下字段全部位于 exact-key `payload`，不得复制正文、SQL 参数或整库
hash。公共 payload keys 为
`{version,eventId,dbKey,projectInstanceIdSha256,createdAt,ownershipHash,connectionEpoch}`；
`version=1`，eventId/connectionEpoch 为 UUID-v4，createdAt 为
`YYYY-MM-DDTHH:mm:ss.sssZ`，dbKey/projectInstanceIdSha256/ownershipHash 为 64 lowercase
hex。identity 的 exact shape 始终是 `{dev:<decimal string>,ino:<decimal string>}`。
所有历史事件的 dbKey/projectInstanceIdSha256/ownershipHash 必须与 immutable genesis 一致；
已终结历史可保留其原 connectionEpoch。Task 3 的直接 attempt 中 source、prepared 与直接
terminal 共享 source epoch，且只有本次待消费 source 必须等于当前 store epoch。
Task 4 的新 recovery epoch 可以用 `recovery_before_commit` rolled_back 或 recovered
committed 终结旧 prepared；Task 3 的历史 parser 必须允许这两种受限跨 epoch terminal，
但 Task 3 自身只产生与 source/prepared 同 epoch 的直接 terminal。
operationKind 只能是
`chapter_body_write|project_metadata_write|project_structure_write|ai_usage_write|chat_write|project_seed`；
targetKind 只能是
`project|volume|chapter|character|world_entry|timeline|auxiliary|token_usage|chat|seed`。
各 type 只允许再增加：

- `manuscript.source`：
  `{logicalRequestDigest,attemptSeq,previousAttemptSourceDigest,operationKind,targetKind,
  targetIdSha256,expectedDataVersion}`。attempt 从 1 开始；首次 previous 为 null，重试必须
  指向前一 source digest；logicalRequestDigest、非 null previous 和非 null targetIdSha256
  均为 64 lowercase hex；targetIdSha256 可为 null；expectedDataVersion 只能是非负 safe
  integer 或 null。target 只含类别和不反推正文的 id hash。
- `manuscript.source.abandoned`：`{sourceDigest,reasonCode}`；sourceDigest 为 64 lowercase
  hex，reasonCode 只能是 `validation_failed|cas_failed|cancelled|superseded`。
- `sqlite.tx.prepared`：
  `{transactionId,sourceDigest,beforeSeq,expectedFinalSeq,schemaVersion,backend,
  expectedGateEmpty,expectedTriggerVersion,expectedTriggerSetDigest,expectedIdentity,
  operationKind}`，transactionId 为 UUID-v4、sourceDigest/expectedTriggerSetDigest 为
  64 lowercase hex、beforeSeq 为非负 safe integer、`expectedFinalSeq=beforeSeq+1`、
  schema/backend/gate/version 固定为 `11/native-sqlite-v2/true/1`。
- `sqlite.tx.committed`：
  `{preparedDigest,finalSeq,schemaVersion,backend,gateEmpty,triggerVersion,
  triggerSetDigest,postCommitIdentity}`；preparedDigest/triggerSetDigest 为 64 lowercase
  hex，finalSeq 为正 safe integer，其余固定为 `11/native-sqlite-v2/true/1`。
- `sqlite.tx.rolled_back`：
  `{preparedDigest,beforeSeq,reasonCode,rollbackKind,predicate}`；rollbackKind 只能是
  `begin_not_acquired|transaction_rolled_back|recovery_before_commit`，preparedDigest 为
  64 lowercase hex、beforeSeq 为非负 safe integer。reasonCode 与 rollbackKind 一一对应：
  `begin_not_acquired→sqlite_busy`、`transaction_rolled_back→transaction_failed`、
  `recovery_before_commit→crash_recovery`。predicate 是判别联合：
  - begin_not_acquired exact keys：
    `{autocommit,writeLockAcquired,gateSqlExecuted,businessSqlExecuted,seqSqlExecuted,
    schemaVersion,backend,finalSeq,gateEmpty,triggerVersion,triggerSetDigest,identity}`，前五个
    值固定为 `true,false,false,false,false`，finalSeq=beforeSeq；
  - transaction_rolled_back exact keys：
    `{autocommit,rollbackCompleted,schemaVersion,backend,finalSeq,gateEmpty,triggerVersion,
    triggerSetDigest,identity}`，前两个固定为 true，finalSeq=beforeSeq；
  - recovery_before_commit exact keys：
    `{autocommit,hotJournalRecovered,schemaVersion,backend,finalSeq,gateEmpty,triggerVersion,
    triggerSetDigest,identity}`，前两个固定为 true，finalSeq=beforeSeq。
  三者的 schema/backend/gate/version 固定为 `11/native-sqlite-v2/true/1`，digest 与 identity
  使用上述 exact 格式，不允许额外键。

parser 必须 exact-key、exact-type、safe-integer 校验。`executeTransaction()` 只执行一次
attempt：它要求 source 是当前唯一未消费 successor，且 dbKey/instance/ownership/epoch、
logicalRequestDigest、attemptSeq、operationKind 全部匹配，然后以 source digest 为 CAS tail
append prepared。同一 source 只能被一个 prepared 或 abandoned 消费。fixture helper（未来
由 ManuscriptService 接管）负责 append source/abandoned；busy 后是否进行最多一次新
source attempt 也属于调用者，不属于 store。

source-only cleanup 同样属于调用者：cold facade 只报告 pending source 并接受上述 exact
abandoned successor，不创建或修写任何 source/abandoned event。prepared recovery terminal
可以使用 fresh recovery epoch；source cleanup 必须继续使用原 source epoch。

### Bounded ControlStore

- `openControlStore(controlDir)` 严格等价于
  `openControlStore(controlDir, { bounded: false })`。只有 exact `{bounded:true}` 才启用
  Stage B tail/checkpoint；默认 `bounded:false` 的 facade、返回值、错误和目录字节保持 v1
  行为，不创建 tail/checkpoint。
- 对已存在目录，必须在 `mkdir`、active-record write/fsync、temp cleanup 和 legacy event
  replay 之前完成零写分类。没有任何 tail/checkpoint final 或 candidate metadata 才是
  pure-v1；出现任一此类 metadata 即为 bounded-v2 candidate。read-only inspector 自动
  验证两类且零写；default writer 遇 bounded-v2 必须以
  `CONTROL_STORE_PROTOCOL_UNSUPPORTED` 零写拒绝，绝不能在已 GC 的目录中从 seq 1 猜测
  重放；这个拒绝也覆盖 exact-name tail/checkpoint candidate。bounded writer/inspector 只
  接受 `controlProtocolEpoch=2` 的冻结 schema；otherwise-exact 的更高 protocol epoch 返回
  `CONTROL_STORE_PROTOCOL_UNSUPPORTED`，低于 2、修改 epoch-2 固定参数或不在既有/bounded
  exact allowlist 的条目返回 `CONTROL_STORE_CORRUPT`。
- bounded facade 的 `read()` 只返回 checkpoint 之后的 active absolute suffix；`tail()` 对
  完全空 evidence 返回 `null`，否则只返回 exact frozen `{seq,digest}` reference，不尝试
  重造已 GC tail event。`readEvidence()` 固定返回 exact frozen
  `{checkpoint,events,tail}`：`checkpoint` 是完整已验证 checkpoint 或 `null`，`events` 与
  `read()` 相同，`tail` 是完整 persistent tail record。
- 为保持 facade shape，bounded facade 继续拥有 `retire()` 与 `retireAndActivate()` 方法名，
  但从 tail-only evidence 起两者始终同步抛稳定
  `CONTROL_STORE_PROTOCOL_UNSUPPORTED`。进入方法后必须在读取/验证 destination、取得任何
  lease、filesystem read/write、legacy event replay、cleanup 或 validator callback 之前拒绝；
  validator 调用数必须为 0，目录树逐字节不变。默认/pure-v1 facade 的既有 retirement 行为
  不变。
  checkpoint-aware retirement/activation 不属于 Task 5–7；必须等待后续显式合同后才能启用。
- `inspectControlStoreEvidence()` 的 outer exact `{events,projection}` 和 projection exact
  `{incarnationId,tail,checkpoint,events}` 均保持不变。bounded 时 outer `events` 只含 active
  suffix；projection `tail` 仍为 `null|{seq,digest}`，projection `events` 仍只投影
  `{seq,type,digest,prevDigest}`，projection `checkpoint` 只允许：

```json
{
  "checkpointDigest": "<64 lowercase hex>",
  "coveredSeq": 12345,
  "coveredDigest": "<64 lowercase hex>",
  "chainRoot": {"seq": 1, "digest": "<64 lowercase hex>"},
  "latestCleanBasisDigest": "<64 lowercase hex>"
}
```

  没有 checkpoint 时 projection `checkpoint=null`；inspector 不投影 checkpoint identity、
  Bloom bytes 或 raw payload。
- checkpoint final：
  `.controlstore-checkpoint-<coveredSeq>-<checkpointDigest>.json`
- tail commit record：`.controlstore-tail.json`
- checkpoint candidate：`.controlstore-checkpoint-<coveredSeq>-<uuid-v4>.tmp`；内容与将发布的
  final checkpoint exact canonical bytes 相同，不允许 wrapper/额外 key。
- tail candidate：`.controlstore-tail-<uuid-v4>.tmp`；内容与将 replace 的 persistent tail
  exact canonical bytes 相同，不允许 wrapper/额外 key。
- checkpoint exact schema（`checkpointDigest` 对去掉自身字段后的 canonical JSON 做
  SHA-256）：

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
  "coveredDigest": "<event digest>",
  "chainRoot": {"seq": 1, "digest": "<first event digest>"},
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
  "latestCleanBasisDigest": "<event digest>",
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
  exact data object，nested logical key order 冻结为
  `checkpointFile,checkpointDigest,coveredSeq,coveredDigest`。canonical JSON 仍按既有规则排序；
  去掉 top-level `checkpointDigest` 后计算的 digest 覆盖整个 `previousCheckpoint`。

  安装前 old persistent tail 没有 checkpoint 时，首次 checkpoint 的 `previousCheckpoint` 必须
  exact `null`；old persistent tail 已引用 checkpoint 时，真正安装的 repeated checkpoint 必须把
  该 old tail reference 的 `checkpointFile/checkpointDigest/coveredSeq/coveredDigest` 逐项复制到
  `previousCheckpoint`，且 current `coveredSeq` 必须严格大于
  `previousCheckpoint.coveredSeq`。Task 5 parser 在本 Task 更新后只机械验证 null-or-exact shape、
  positive safe-integer `coveredSeq`、两个 digest 都是 64 lowercase hex、basename exact
  `.controlstore-checkpoint-<coveredSeq>-<checkpointDigest>.json`，以及
  `previousCheckpoint.coveredSeq < coveredSeq`；它不得要求 descriptor 指向的 old final 仍存在。
  首次/null 与 repeated/inherited 的 authority 证明由 Task 6 installer 承担。

  首次 checkpoint 的 `admissionBasis.admissionEvent` 必须是已经外部 authority 认证的 exact
  canonical seq-1 event deep copy；parser 重算其 event digest，并要求它同时等于
  `basisDigest`、`chainRoot.digest`，且 `chainRoot.seq=1`。fixture verifier 仍须用 descriptor
  `genesisDigest/fixtureRunId` 认证；checkpoint 不能自证 authority。这个 epoch-2 Stage B
  `admissionBasis` schema 只允许 exact fixture genesis。production activation 前必须另行冻结
  production basis 的 exact tagged union 与显式 migration，不能把 hardcoded fixture schema
  解释成 production authority。后续 checkpoint 必须逐字继承整个 `admissionBasis`。
  `chainRoot`、cumulative `eventTypeCounts` 和 Bloom filter 也跨 repeated checkpoint 精确继承；
  `unresolved` 必须 exact `[]`，`retryContinuationOpen` 必须 exact
  `false`。checkpoint 不允许任何 `formalSha256` 字段，也不保存正文、SQL、参数或数据库
  bytes。`eventTypeCounts` 和 `epochObservationCount` 是截至 `coveredSeq` 的累计值而不是本段
  增量。

  Bloom encoding 固定为 1 MiB（1,048,576 bytes）bitset；`bitsBase64` 必须是 RFC 4648
  canonical base64，解码长度 exact 1,048,576，重新编码必须逐字节相同。algorithm 固定为
  `sha256-domain-separated-v1`。插入和查询前都先验证 UUID-v4，再规范化为 lowercase canonical
  ASCII；禁止 raw 大小写进入 filter 或 active used-epoch set。令 domain 为 UTF-8 bytes
  `mythpen-controlstore-connection-epoch-v1\0`，令 `basisRaw` 为
  `admissionBasis.basisDigest` 的 32 raw bytes；对每个 `i=0..6` 计算
  `SHA-256(domain || one-byte(i) || basisRaw || normalizedEpochAscii)`，取 digest 开头 23 bits
  的 big-endian unsigned value为 index；若 digest bytes 为 `d`，精确公式是
  `(((d[0]<<16)|(d[1]<<8)|d[2]) >>> 1)`。bit numbering 固定为 byte 内
  least-significant-bit first。

  只有经过 native exact parser 且其冻结 event schema 明确拥有
  `payload.connectionEpoch` 的 covered event 才贡献 observation；legacy/generic payload 中
  偶然同名字段绝不进入 filter。每个合格 event 计一次并设置七个位，重复 epoch 仍增加
  observation count。无 previous checkpoint 时，首次 checkpoint 在 GC 前从
  全部 covered events 构造。后续 checkpoint 必须从 previous filter exact bytes 开始，仅
  bitwise-OR 本次新覆盖 absolute suffix `(oldCoveredSeq,newCoveredSeq]` 的 hashes，并令
  `epochObservationCount = previousCount + newSuffixObservations`；禁止从剩余 active suffix
  重建、清任何 bit、改变参数或编码。`checkpointDigest` 覆盖整个 filter，tail 的
  `checkpointFile/checkpointDigest` 引用它，`recordDigest` 又覆盖该引用；不得接受 detached
  filter。上述单调规则保证没有 false negative。

  epoch-2 filter 的 actual popcount 硬不变量为 `<= 4,194,304`（50%）。Task 6 在发布
  checkpoint final、tail commit 或 GC 之前计算 inherited-OR candidate；若 popcount 将超过
  该值，返回稳定 `CONTROL_CHECKPOINT_BLOCKED`、保留旧 checkpoint/tail/events 且零 GC，等待
  新 protocol 扩容。磁盘上 epoch-2 checkpoint 已超过该值属于
  `CONTROL_STORE_CORRUPT`。algorithm/bitCount/hashCount/encoding 或阈值不得在 epoch 2 内改变；
  改变必须提升 `controlProtocolEpoch` 并提供显式迁移。50% 时单次 false-positive `<=2^-7`、
  128 个独立随机 UUID 全耗尽 `<=2^-896` 只是 random-oracle/独立 UUID 下的可用性估计，不是
  无条件密码学保证；安全性来自 false positive 只拒绝、连续 128 次命中后 fail-closed
  `RECOVERY_REQUIRED`。Task 7 fresh epoch 还必须不在 active suffix exact used-epoch set 中。

  Task 6 的 installer 只能经 internal controller 调用：module-private
  `WeakMap<boundedFacade,controller>` 保存 identity；bounded facade 不增加任何 property；
  `module.exports.getBoundedControlStoreCheckpointController` 是唯一 non-enumerable、
  non-writable、non-configurable seam，controller exact frozen
  `{installCheckpoint,maintenanceStatus}`。同一 loaded module 实际 mint 的 bounded facade 才能
  取回同一 controller；default/duck/另一 module instance 的 facade 固定零写
  `CONTROL_STORE_PROTOCOL_UNSUPPORTED`。non-enumerable 仅是 API hygiene，不是安全边界；Task 6
  只有 testing harness 可调用，Task 7 才允许 real native module 成为第二个 runtime caller。

  checkpoint startup reconcile 属于 bounded `openControlStore()` bootstrap：在 facade 创建和
  WeakMap/controller 注册之前，先取得 lifecycle + writer 双 lease并只读 classify/partition
  checkpoint proposals；checkpoint `TC` 绝不进入 Task 5 ordinary tail-candidate reconcile。
  malformed/conflicting/mixed-invalid `P` 必须零写失败，不能先推进 event tail。唯一合法 old-tail
  `P` cleanup + directory fsync，或 new-tail authority partial GC 完成后，才执行 Task 5 ordinary
  event-successor/tail-candidate reconcile并稳定重读 persistent tail。整个 bootstrap 不调用
  provider；只有 clean-reconciled evidence 才能 mint facade/controller。
  `installCheckpoint(authorityProvider)` 只接受这样的 facade；它在新的 lifecycle + writer 双
  lease 内先执行同一个 read-only classifier。若发现会推进 authority 的 unreferenced event
  successor、任何 checkpoint proposal/tail candidate、或 new-tail partial GC，当前调用零写
  `RECOVERY_REQUIRED` 并 fence facade/controller，要求 fresh bounded reopen；不得按 old snapshot
  先 reconcile 再 install。只有 classifier 仍为 clean 时才重读 current stable evidence，并在
  **本次新 checkpoint**的 candidate/tail/GC
  mutation 前同步且只调用 provider 一次。provider 绝不基于 startup old tail。provider 返回
  recursively exact frozen data-only
  `{snapshot,cleanBasis,epochObservations}`；snapshot exact
  `{incarnationId,tail:{seq,digest},cleanBasisDigest}`，cleanBasis exact
  `{admissionBasis,dbKey,schema,backend,finalSeq,triggerVersion,triggerSetDigest,
  projectInstanceIdSha256,identity,latestCleanBasisDigest,unresolved:[]}`。所有 nested value 只允许
  exact enumerable data properties；accessor、symbol、custom prototype、extra key、mutable value
  或 thenable 均拒绝。snapshot incarnation/tail 必须逐项等于双 lease 内 current persistent
  evidence，并满足
  `snapshot.cleanBasisDigest === cleanBasis.latestCleanBasisDigest === current tail.digest`。
  provider throw/shape/snapshot 失败固定 `RECOVERY_REQUIRED`、零写、无 receipt。core 自行派生
  coverage、chainRoot、累计 counts、Bloom OR、`unresolved=[]` 与
  `retryContinuationOpen=false`；不得信任 provider 给出这些派生值。

  repeated checkpoint 时，若 stable current `tail.seq === previous coveredSeq`（active suffix
  exact 0），installer 仍按上述规则调用并验证 provider exactly once；
  `epochObservations` 必须 exact `[]`；provider `cleanBasis` 必须 canonical-equal current
  checkpoint 的 exact clean-basis projection
  `{admissionBasis,dbKey,schema,backend,finalSeq,triggerVersion,triggerSetDigest,
  projectInstanceIdSha256,identity,latestCleanBasisDigest,unresolved}`，snapshot 仍独立遵守上文
  current incarnation/tail/cleanBasisDigest 规则。随后不创建 candidate、
  不改 tail、不 GC；current checkpoint canonical bytes（包括 `previousCheckpoint`）与 persistent
  tail 逐字节不变，也不生成新的 predecessor descriptor。待双 lease known-success release 后返回
  previous checkpoint 的 exact frozen no-op receipt `{checkpointDigest,coveredSeq}`。因此只有
  真正安装的新 checkpoint 才要求
  `newCoveredSeq > oldCoveredSeq`；empty active suffix 不是 `CONTROL_CHECKPOINT_BLOCKED`。若
  current checkpoint 为 null 且 persistent tail 也完全空，则没有 clean basis 可压缩：provider/
  authoritySource 调用 0 次，稳定零写 `CONTROL_CHECKPOINT_BLOCKED`。

  checkpoint 绝不能切断 logical retry，但 Task 6 不负责证明 retry closure。Task 7 的
  ProjectWriteCoordinator closure-private writer turn 必须覆盖 source attempt 1、可选 attempt 2
  与最终 retry 决策；只有该 turn 关闭后，maintenance 才按同一锁序进入。Task 7 bounded
  fixture 保持 frozen zero-argument public `checkpoint()`；它不接受 caller basis、token、
  consumer 或 `retryContinuationOpen` raw boolean，而由 coordinator 用下文 exact one-shot
  pending job 进入下一 exclusive maintenance turn。checkpoint 后首个 `manuscript.source` 必须
  同时满足 `attemptSeq=1` 和 `previousAttemptSourceDigest=null`，任一不满足或任何跨
  checkpoint continuation 都以 `NATIVE_ADMISSION_REJECTED` 拒绝。

- tail exact schema（`recordDigest` 同样排除自身后计算）：

```json
{
  "version": 1,
  "recordDigest": "<64 lowercase hex>",
  "controlProtocolEpoch": 2,
  "incarnationId": "<uuid-v4>",
  "checkpointFile": ".controlstore-checkpoint-12345-<digest>.json",
  "checkpointDigest": "<64 lowercase hex>",
  "coveredSeq": 12345,
  "coveredDigest": "<event digest>",
  "tailSeq": 12345,
  "tailDigest": "<event digest>",
  "activeEventCount": 0,
  "activeEventBytes": 0
}
```

  bounded 模式尚无 checkpoint 时，`checkpointFile/checkpointDigest/coveredDigest=null`、
  `coveredSeq=0`。完全空 bounded evidence 固定为 `tailSeq=0,tailDigest=null,
  activeEventCount=0,activeEventBytes=0`；非空时 `tailSeq/tailDigest` 指向 absolute tail。
  `activeEventCount = tailSeq - coveredSeq`；`activeEventBytes` 只累计 active official event
  canonical UTF-8 bytes，不含 checkpoint/tail/temp/lock。checkpoint-only evidence 的
  `tailSeq/tailDigest` 等于 `coveredSeq/coveredDigest` 且 active count/bytes 都为 0。
  `recordDigest` 覆盖包括 `checkpointFile/checkpointDigest` 在内的所有其他 tail 字段；tail
  reference 与 checkpointDigest 必须逐项匹配 referenced checkpoint，不能替换或分离 filter。
- checkpoint 后 event 文件仍使用绝对 seq；首个 active event 必须是
  `coveredSeq + 1` 且 `prevDigest = coveredDigest`，绝不从 1 重编号。
- `.controlstore-tail.json` 是 checkpoint 激活提交点；未被 tail 引用的 checkpoint
  final 只是孤儿，不能授权删除旧 event。
- checkpoint final 通过同目录 `wx` candidate、file fsync、hard-link no-clobber、
  directory fsync 安装；tail 通过 candidate、file fsync、atomic replace、directory
  fsync 提交。tail 提交并 post-check 前禁止删除任何 covered event。
- checkpoint startup 发生在 bounded open bootstrap、facade/WeakMap 前的双 lease 内且无需
  provider。它先只读 classify/partition checkpoint proposals，malformed/conflicting/
  mixed-invalid `P` 零写失败；合法 proposal cleanup/new-tail GC 后才运行 Task 5 ordinary
  event-successor/tail-candidate reconcile并稳定重读。任何 authority-changing successor 都必须
  在 mint controller/provider 前吸收，provider 绝不看旧 tail。令
  `C=checkpoint candidate`、`F=hard-linked orphan final`、
  `TC=checkpoint-tail candidate`；old persistent tail 下合法 proposal 集合 `P` 只允许 exact
  `{C}`、`{C,F}`、`{F}`、`{F,TC}`。`{C,F}` 必须证明 hard-link identity 与 canonical bytes；
  `{F,TC}` 的 coveredSeq/digest/canonical bytes 与 tail
  candidate linkage 必须逐项一致；bootstrap 删除唯一合法 `P` 的全部成员后只做一次
  directory fsync，不得
  激活或 GC。old-tail `P` 的分类只由上述 topology/linkage 决定，与 proposal checkpoint 内的
  `previousCheckpoint` 无关；该字段在此只接受机械 schema 验证，绝不授权删除 predecessor 或改变
  `P` 集合。

  persistent tail 已引用 new checkpoint 时，以 current referenced final 为唯一 authority，并从其
  digest-covered `previousCheckpoint` 决定是否存在唯一可 GC predecessor。descriptor 为 `null` 时
  不允许任何 unreferenced checkpoint final；descriptor 非 null 时，其 exact `checkpointFile` 若已
  缺失即视为该 predecessor 已被删除，若存在则必须是现场唯一 unreferenced checkpoint final，且
  core 必须完整解析其 exact checkpoint schema、重算其 checkpoint digest，并要求 actual basename
  等于 descriptor `checkpointFile`、parsed checkpoint 的
  `checkpointDigest/coveredSeq/coveredDigest` 分别等于其余三字段后才可删除。不得按 coveredSeq
  邻近、文件数量或 digest 猜测 predecessor。covered-event residue 与这个
  descriptor-matched predecessor 可幂等 GC，partial GC 不回滚 tail；任何额外 exact unreferenced
  final、valid-but-mismatched descriptor target 或其他 orphan/proposal 都是
  `RECOVERY_REQUIRED` conflict，任何 malformed checkpoint final 是
  `CONTROL_STORE_CORRUPT`。该现场若仍有**任何** checkpoint candidate
  （包括与 referenced checkpoint byte-identical 的 candidate），沿用 Task 5 负控：writer 与
  inspector 都零写 `RECOVERY_REQUIRED`，绝不 cleanup。
  tail replace 是否发生只按磁盘 tail 判定。`TC` without `F`、pair mismatch、同时出现两个
  proposal `P`、multiple/conflicting candidates、同 coveredSeq 不同 digest 返回
  `RECOVERY_REQUIRED`；malformed candidate/final 或 referenced
  checkpoint missing/corrupt 返回 `CONTROL_STORE_CORRUPT`。inspector 对任何 exact candidate/
  orphan 固定零写 `RECOVERY_REQUIRED` 且不返回 partial projection；malformed 固定
  `CONTROL_STORE_CORRUPT`。
- soft high-water：4,096 events 或 16 MiB；hard high-water：8,192 events 或
  32 MiB；count/bytes 以 OR、inclusive `>=` 分类。Task 6 只通过 controller
  `maintenanceStatus()` 报告 pressure，不在 generic bounded append/CAS 上阻断。Task 6 的
  zero-mutation `CONTROL_CHECKPOINT_BLOCKED` 仅表示 empty/no-clean-basis 或 Bloom 50% protocol
  cap 无法构造安全 checkpoint；Task 7 才在 logical-request 边界用该码表示 hard pressure 下
  无 current clean job，并阻塞
  下一次 admission；已开始 request/retry/terminal 必须先完整闭合。controller 只在 fresh open
  已完成 partial GC 后 mint，因此正常 status 看不到 partial state；每次调用仍先检查 fenced，
  再复用零写 classifier：fenced 优先 `CONTROL_STORE_FENCED`，exact unresolved candidate/orphan/
  successor 或后来出现的 partial GC 为 `RECOVERY_REQUIRED`，malformed metadata 或 referenced
  checkpoint missing/corrupt 为 `CONTROL_STORE_CORRUPT`，绝不返回 stale level。
- bounded append 固定为 event candidate/publish/file+directory fsync → tail candidate/file
  fsync/atomic replace/directory fsync → tail/event post-check → return。tail 提交失败立即
  fence，禁止第二次 append。任何 official event 已发布而 event+tail 双 post-check 尚未全部
  成功的同步 failure，当前调用首先抛 `RECOVERY_REQUIRED` 并把当前 facade fenced；该 facade
  后续所有方法稳定返回 `CONTROL_STORE_FENCED`。在 event publish 之前且 exact cleanup 已证明
  的 I/O failure 仍沿用 `CONTROL_STORE_IO`，不伪造 recovery uncertainty。
- bounded bootstrap 或 append 已完成 tail/event exact 双 post-check 后，inner writer lease 或
  outer lifecycle lease 的 release throw/状态不明仍属于已安装后的 uncertainty：当前调用首次
  稳定抛 `RECOVERY_REQUIRED`、不得返回 append/bootstrap receipt，并立即把已有 facade fenced；
  其后所有方法稳定 `CONTROL_STORE_FENCED`。bootstrap 尚未返回 facade 时，open 直接抛该错误，
  新 bounded reopen 只能按 persistent tail 唯一收敛且不得 duplicate。`RECOVERY_REQUIRED.cause`
  保留第一个 mapped release failure 的对象 identity，后续 release failure 追加到
  `secondaryErrors`，不得用普通 `CONTROL_STORE_IO` 覆盖 primary。event/tail publish 前没有
  commit 且 cleanup exact proven 的 failure 继续沿用原 I/O 语义。
- pure-v1/empty bootstrap 的 tail replace 使用同一 uncertainty cut：atomic replace 可能已经
  安装 final 后发生的任何同步 failure 首次返回 `RECOVERY_REQUIRED` 并 fence；只有 publish
  前 failure 且 candidate cleanup exact proven 才返回 `CONTROL_STORE_IO`。
- 重启只能在 writer lease 内验证并吸收唯一未引用 `tailSeq+1` successor，然后 durable
  advance tail；无 successor 保持不变。hole、多个 successor、wrong seq/prevDigest/digest 或
  present-but-mismatch 都返回 `RECOVERY_REQUIRED`。metadata exact schema/digest 错误、tail
  引用 event 缺失，以及 referenced checkpoint missing/corrupt 都返回
  `CONTROL_STORE_CORRUPT`。
- read-only inspector 永不 cleanup、advance tail 或 consume successor。发现 exact candidate
  或唯一未引用 successor 时零写返回 `RECOVERY_REQUIRED` 且不返回 partial projection；malformed
  candidate 仍为 `CONTROL_STORE_CORRUPT`。只有 bounded writer 在 writer lease 内可 cleanup/
  reconcile，default writer 一见 candidate 已按上文零写 `CONTROL_STORE_PROTOCOL_UNSUPPORTED`。
- tail fault constants 固定为
  `CONTROL_STORE_TAIL_BEFORE_PUBLISH='controlstore.tail.before-publish'` 和
  `CONTROL_STORE_TAIL_BEFORE_DIR_FSYNC='controlstore.tail.before-dir-fsync'`。强杀矩阵固定六行：
  pure-v1 bootstrap tail 的 before-publish/before-dir-fsync，两条 existing bounded append
  event 的 `CONTROL_STORE_APPEND_BEFORE_PUBLISH/BEFORE_DIR_FSYNC`，以及 append tail 的
  before-publish/before-dir-fsync。parent 在 bounded writer reopen/reconcile 前不得调用别的
  writer；read-only inspector 可用于证明 candidate/successor 返回零写 `RECOVERY_REQUIRED`，
  但不得投影或消费它。每行都断言 exact `readEvidence()`、无 duplicate、counters/bytes 和
  next absolute seq。
- checkpoint fault constants 固定为：
  `CONTROL_STORE_CHECKPOINT_BEFORE_PUBLISH='controlstore.checkpoint.before-publish'`、
  `CONTROL_STORE_CHECKPOINT_BEFORE_CANDIDATE_UNLINK='controlstore.checkpoint.before-candidate-unlink'`、
  `CONTROL_STORE_CHECKPOINT_BEFORE_FINAL_DIR_FSYNC='controlstore.checkpoint.before-final-dir-fsync'`、
  `CONTROL_STORE_CHECKPOINT_AFTER_FINAL_DIR_FSYNC='controlstore.checkpoint.after-final-dir-fsync'`、
  `CONTROL_STORE_CHECKPOINT_BEFORE_GC='controlstore.checkpoint.before-gc'`、
  `CONTROL_STORE_CHECKPOINT_AFTER_GC_ENTRY='controlstore.checkpoint.after-gc-entry'`、
  `CONTROL_STORE_CHECKPOINT_BEFORE_GC_DIR_FSYNC='controlstore.checkpoint.before-gc-dir-fsync'`。
  checkpoint tail activation 复用两个 Task 5 tail points，并在两者 context 中增加 exact
  `operation:'checkpoint-activation'`；`AFTER_GC_ENTRY` context 用 exact
  `entryKind:'event'|'old-checkpoint'` 与 basename `entryName` 区分 partial GC；
  `entryKind:'old-checkpoint'` 时 `entryName` 必须 exact 等于 current checkpoint
  `previousCheckpoint.checkpointFile`。descriptor target 已缺失时不得伪造 old-checkpoint delete 或
  触发该 entry fault。
- Bloom cap 超限在任何 checkpoint final/tail/GC mutation 前返回
  `CONTROL_CHECKPOINT_BLOCKED`，完整保留旧 evidence。provider/snapshot 不可信是零写
  `RECOVERY_REQUIRED`。old tail 仍权威且 candidate/orphan cleanup + directory fsync 已精确证明
  时，pre-tail I/O 才是 `CONTROL_STORE_IO`。release mapping 冻结内部
  `authorityMutationAttempted`：checkpoint candidate/final 与 tail candidate write/fsync 期间保持
  false；`CONTROL_STORE_TAIL_BEFORE_PUBLISH` fault 成功返回后、紧邻 tail `atomicReplace` 前才设
  true；new tail exact post-check 后才设 `turn.installed=true`。结合
  Task 5 `turn.installed` 与 mutation disposition：provider/snapshot `RECOVERY_REQUIRED`、empty
  store/Bloom cap
  `CONTROL_CHECKPOINT_BLOCKED` 均为零 mutation primary；伴随 release failure 时保留 semantic
  primary，Recovery primary 的 release failures 进入 `secondaryErrors`，non-Recovery primary
  沿用 `cleanupError` attachment，且不 fence。无 primary、零 mutation 的 release failure 是
  `CONTROL_STORE_IO`；no-op receipt 也只有在 release 成功后返回，零 mutation release failure
  同样为 `CONTROL_STORE_IO`。只有 `authorityMutationAttempted===true`、
  `turn.installed===true`，或 checkpoint/tail/GC mutation disposition unknown，release/operation
  failure 才首次 `RECOVERY_REQUIRED`、fence、无 receipt，后续
  `CONTROL_STORE_FENCED`；first cause identity 与 later `secondaryErrors` 沿用 Task 5 规则。
- bounded-open bootstrap 尚无 facade。若合法 `P` cleanup 或 new-tail partial GC mutation 已成功，
  随后的 writer/lifecycle release failure 使 open 抛 `RECOVERY_REQUIRED`，且只能 fresh bounded
  reopen 唯一收敛；若未发生 bootstrap mutation，release-only failure 沿用 Task 5
  `CONTROL_STORE_IO`。没有 facade 可 fence，也绝不返回半初始化 controller。
- Task 5 baseline 实现 checkpoint/tail parser、pure-v1/empty bootstrap、persistent tail append 和
  unique-successor reconcile；Task 6 为 digest-covered `previousCheckpoint` exact schema 扩展该
  parser/test，但 parser 只机械验证 descriptor 且不检查 old final 是否存在。Task 6 才证明
  installer lineage inheritance、创建 checkpoint、descriptor-only predecessor GC、pressure
  classification 和
  epoch-2 Bloom cap；Task 7 才执行 hard admission scheduling，并让
  NativeProjectStore 以 `admissionBasis` + checkpoint summary + active suffix 认证 aged history，
  并要求 fresh epoch 同时 Bloom-negative 与 active-suffix-unused。

---

### Task 1: Schema 11 canonical generator and direct installer

> **Status: COMPLETE.** Initial implementation `52f8cb1`; frozen-contract review fix
> `e20dd7c`; final independent review **Approve** (20 pass / 0 fail, Critical 0,
> Important 0). Production `db.js` remains schema 10 and unwired.

**Files:**
- Create: `server/native/durability-schema.js`
- Create: `server/testing/native-stage-b-fixture.js`
- Create: `server/tests/durability-schema.test.js`
- Create: `server/tests/fixtures/create-native-stage-b-fixture.js`

**Interfaces:**
- Produces: `WRITABLE_PROJECT_TABLES`, `canonicalTriggerDefinitions()`,
  `canonicalTriggerSetDigest()`, `installSchema11Contract(database)`,
  `inspectSchema11Contract(database)` and `auditWritableTableManifest(database)`.
- Fixture helper spawns the fixture script, which creates a real schema 10 project through
  existing `db.createProjectDb()`, closes all sql.js handles, then returns its path for direct
  `bun:sqlite` tests. The child must override `USERPROFILE`、`HOME`、`LOCALAPPDATA`、
  `APPDATA`、`MYTHPEN_DATA_DIR` and export root to one test-owned directory before loading
  `db.js`; tests snapshot the real default data/control/path-store roots before/after. This
  prevents the config lifecycle lease from touching the developer's stable `.mythpen-control`.
- After the atomic schema install, the helper creates the exact test-only fixture genesis under
  an isolated ControlStore, post-checks DB/evidence equality and returns only opaque fixture
  handles/digests. It never returns a serializable authority token.

- [x] **Step 1: Write the schema generator RED tests**

Assert module absence first, then freeze 18 manifest rows, 54 trigger definitions, bytewise
name ordering, exact reserved-key values/CAS rules, exact fixture genesis and absence of any
production `db.js` wiring change.

- [x] **Step 2: Run the RED suite**

```powershell
bun test ./server/tests/durability-schema.test.js
```

Expected: FAIL because `server/native/durability-schema.js` does not exist.

- [x] **Step 3: Implement tokenizer, manifest and digest**

Implement the frozen Schema 11 contract above. `auditWritableTableManifest()` queries
`sqlite_schema`, excludes only `sqlite_%`, adds the gate/internal allowlist, and rejects every
unknown application table. Do not use `localeCompare`; sort UTF-8 buffers.

- [x] **Step 4: Implement atomic direct-fixture install**

`installSchema11Contract()` must run one `BEGIN EXCLUSIVE` transaction and use this exact order:
verify clean v10 + unique schema_version/project_instance_id + four native keys absent → create
gate → insert gate row 1 (`changes===1`) → create 54 triggers → INSERT the four native keys
(`changes===1` each) → CAS schema_version 10→11 (`changes===1`) while leaving project_instance_id
unchanged → delete gate row (`changes===1`) → verify the six-key final values, empty gate and
three-way digest → COMMIT. This avoids the new `project_meta` trigger blocking its own reserved-key
install. Any error ROLLBACKs to complete v10 with no native marker or genesis.

- [x] **Step 5: Complete negative tests and run GREEN**

Cover missing/extra/altered trigger, unknown table, malformed canonical SQL, digest mismatch,
pre-existing native key, invalid/changed instance, schema CAS miss, closed-gate DML rejection,
open-gate DML success and injected install/genesis failure preserving exact v10 or destroying the
unpublished fixture. Expected: all pass.

- [x] **Step 6: Commit**

```powershell
git add server/native/durability-schema.js server/testing/native-stage-b-fixture.js server/tests/durability-schema.test.js server/tests/fixtures/create-native-stage-b-fixture.js
git commit -m "feat: define the native durability schema contract"
```

### Task 2: Native connection, identity guard and SQL authorization

> **Status: COMPLETE.** Initial implementation `fa6a26b`; independent-review fixes
> `510676e`; final independent review **Approve** (91 pass / 1 existing POSIX-only skip /
> 0 fail, Critical 0, Important 0, Minor 0). The production factory remains disabled and
> no user project, schema version or production open/write path is wired to native storage.

**Files:**
- Create: `server/native/database-identity-guard.js`
- Create: `server/native/native-sql-authorization.js`
- Create: `server/native/native-project-store.js`
- Create: `server/testing/native-stage-b-store.js`
- Create: `server/tests/native-project-store.test.js`
- Test: `server/tests/sqljs-atomic-store.test.js`

**Interfaces:**
- Produces: `createDatabaseIdentityGuard({databasePath, fsApi})`,
  `classifyNativeSql(sql)`, private durability capability, core store with the frozen facade,
  and the only Stage B entry `createStageBFixtureStore()` in `server/testing/`.
- Consumes Task 1 `inspectSchema11Contract()` and existing controlled-path rules.
- The core refuses empty evidence. The testing factory requires the exact post-checked genesis;
  no production-facing factory accepts fixture evidence in Stage B.

- [x] **Step 1: Write RED tests for connection and identity**

Cover exact PRAGMA readback including `busy_timeout=100`, empty/missing/wrong fixture genesis,
missing/non-function/throwing/extra-key/wrong-basis admissionVerifier, ordinary-entry rejection of
fixture evidence, read-only facade, stale epoch after close/fence, same-path file replacement,
extra hardlink, symlink/junction/reparse ancestor and project instance change.

- [x] **Step 2: Write RED tests for authorization**

Business reads are allowed; business DML is allowed only inside the transaction facade;
business code cannot mutate gate/reserved keys, install/drop reserved triggers, attach another
database, issue transaction control, PRAGMA writes or multiple statements.

- [x] **Step 3: Run RED**

```powershell
bun test ./server/tests/native-project-store.test.js
```

Expected: FAIL because the native store modules do not exist.

- [x] **Step 4: Implement minimal connection and guard**

Before any SQLite statement can recover a hot journal, freeze canonical path + read-only
file-handle identity and match it to genesis/ControlStore evidence. Then open that exact path with
`bun:sqlite`, configure/read back PRAGMAs and create a UUID connection epoch. Revalidate pathname,
handle identity, link count, instance and epoch before every transaction and before COMMIT.
Operational uncertainty fences before reporting.

- [x] **Step 5: Implement fail-closed facade and run GREEN**

Keep the raw connection and durability capability in closure-private state. Unknown SQL shapes
are rejected. `close()` marks released only after the underlying close succeeds; close failure
leaves `disposition_unknown` and all cached facade calls fail.

- [x] **Step 6: Run focused v1 regression and commit**

```powershell
bun test ./server/tests/native-project-store.test.js ./server/tests/sqljs-atomic-store.test.js
git add server/native/database-identity-guard.js server/native/native-sql-authorization.js server/native/native-project-store.js server/testing/native-stage-b-store.js server/tests/native-project-store.test.js
git commit -m "feat: add the direct native project store facade"
```

### Task 3: Native transaction terminals and bounded busy behavior

> **Status: COMPLETE.** Implementation `9fad6b2`, review fixes `d32cbbd` and `35f718a`;
> final independent review **Approve** (Critical 0, Important 0, Minor 0). Fresh focused
> verification: 93 pass / 0 fail. Task 4 recovery, Task 5 bounded ControlStore and production
> wiring remain deferred; production schema remains 10, activation remains off, and no
> installer/push/tag/release was executed.

**Files:**
- Modify: `server/native/native-project-store.js`
- Modify: `server/native/native-sql-authorization.js`
- Modify: `server/testing/fault-injection.js`
- Modify: `server/testing/native-stage-b-store.js`
- Modify: `server/tests/native-project-store.test.js`
- Test: `server/tests/project-write-coordinator.test.js`

**Interfaces:**
- `executeTransaction({sourceDigest, operationKind, logicalRequestDigest, attemptSeq}, fn)`
  executes exactly one attempt, validates/consumes the already durable source, appends
  `sqlite.tx.prepared` before `BEGIN IMMEDIATE` and returns only after terminal post-check.
- Transaction facade exposes `all/get/run` bound to the current epoch; it never exposes raw
  transaction control or durability internal capability.
- The testing factory authenticates the immutable genesis on every open, while core validates the
  full suffix and live DB state. A clean committed store must close and reopen through the same
  factory without using the genesis database hash as a permanent predicate.

- [x] **Step 1: Write RED for normal transaction order**

Assert `source → prepared → BEGIN IMMEDIATE → preflight → gate insert → business DML → seq CAS →
gate delete → COMMIT → committed`, final seq `S+1`, empty gate and no full-file hash. Add exact-key
event parser tests and prove a source with wrong owner/epoch/request/attempt, a consumed source or
a source that is not the expected CAS tail is rejected before BEGIN. Freeze live
`durability_commit_seq` as unique canonical decimal TEXT (`0|[1-9][0-9]*`) within safe-integer
range, and add clean cross-epoch reopen coverage.

- [x] **Step 2: Write RED for the two rollback predicates**

External `BEGIN IMMEDIATE` contention must append `begin_not_acquired`, remain autocommit and
never call ROLLBACK. Failure after BEGIN must ROLLBACK and prove the frozen pre-write predicate
before appending `transaction_rolled_back`. The positive busy fixture holds an external
`BEGIN IMMEDIATE`/RESERVED lock; an EXCLUSIVE/unreadable predicate must fence rather than forge a
terminal.

- [x] **Step 3: Implement normal, busy and rollback paths**

Use exact `changes===1` checks for gate insert, seq CAS and gate delete. A pre-existing gate,
unknown autocommit state, rollback failure or predicate mismatch fences the epoch and returns
`RECOVERY_REQUIRED` without guessing a terminal. From the moment COMMIT is invoked, any COMMIT
throw, non-autocommit return or post-COMMIT predicate uncertainty performs zero ROLLBACK and zero
terminal, fences the epoch and returns `RECOVERY_REQUIRED`.

- [x] **Step 4: Cover terminal append failure and caller-owned bounded retry**

After COMMIT but before committed post-check, do not report business success. Busy retry creates
a new source with incremented attemptSeq and `previousAttemptSourceDigest`, followed by its own
prepared/rolled_back; this is driven by the fixture caller, never internally by the store. A
second busy stops and preserves the draft. Abandon before prepared consumes the source with an
exact `manuscript.source.abandoned` event. Prepared CAS distinguishes a proven source-consumed/
changed tail (no BEGIN, store remains usable) from append/publish/post-check uncertainty (fence +
`RECOVERY_REQUIRED`); terminal uncertainty always fences. Transaction-specific SQL authorization
must reject reserved or ambiguous `project_meta` reads as well as writes, including bound-key
bypasses. Callback thenables, stale statement facades and every same-store reentrant public method
must have explicit negative tests.

- [x] **Step 5: Run GREEN and commit**

```powershell
bun test ./server/tests/native-project-store.test.js ./server/tests/project-write-coordinator.test.js
git add server/native/native-project-store.js server/native/native-sql-authorization.js server/testing/fault-injection.js server/testing/native-stage-b-store.js server/tests/native-project-store.test.js
git commit -m "feat: add native transaction durability terminals"
```

### Task 4: Crash recovery and connection epoch fencing

> **Status: COMPLETE.** Implementation commit `27cf706` and fixed-review commit `4898482`
> are both on `codex/l1-durability-foundation`. Fresh fixed-review verification is
> `84/84` native tests, `14/14` real-crash tests and `136/136` native + crash + coordinator
> tests. Independent rereview is `C0/I0`; the worktree was clean after the fixed commit.
> No installer, push, tag or release was run or authorized.

**Files:**
- Modify: `server/native/native-project-store.js`
- Modify: `server/testing/fault-injection.js`
- Modify: `server/tests/native-project-store.test.js`
- Create: `server/tests/fixtures/native-project-store-crash.js`
- Create: `server/tests/native-project-store-crash.test.js`

**Interfaces:**
- Factory classifies clean/source-only/prepared before SQLite open. clean becomes active with a
  fresh epoch; pending evidence returns the frozen cold facade described above.
- `recover()` runs under the existing project writer lease and returns only the frozen exact
  union. source-only returns `source_pending` with zero SQLite/append until caller-owned exact
  abandoned cleanup. Prepared + DB seq `beforeSeq` appends `recovery_before_commit`; prepared +
  `expectedFinalSeq` and exact predicates appends recovered committed; every other state is
  `RECOVERY_REQUIRED`.
- Before `sqliteFactory`, and again after it but before the first SQLite statement, prepared
  recovery revalidates pathname/handle identity, ControlStore exact tail and writer lease. Only
  then may the controlled connection recover a hot journal and validate live predicates.
- same-path replacement before SQLite maps clean/source-only to
  `NATIVE_DATABASE_IDENTITY_STALE`; prepared/recovery mismatch maps to `RECOVERY_REQUIRED` with
  zero SQLite statements. Active replacement follows the ordinary fence path. Invalid admission
  or suffix remains `NATIVE_ADMISSION_REJECTED`.

- [x] **Step 1: Add crash RED matrix**

Every row below must run in a real child process and use strong kill, not a thrown exception. Reuse
all nine frozen Task 3 `NATIVE_TX_*` points; scope the two existing ControlStore append points to the
committed terminal append; add `NATIVE_TX_AFTER_TERMINAL_POSTCHECK` as a crash-only point that can
kill but can never throw:

| strong-kill boundary | exact recover classifier | stable business state |
|---|---|---|
| caller after durable source post-check | `source_pending`; caller appends exact abandoned, then clean | before |
| `NATIVE_TX_AFTER_PREPARED_POSTCHECK` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_BEGIN_ACQUIRED` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_GATE_INSERT` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_BUSINESS_CALLBACK` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_SEQ_CAS` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_GATE_DELETE` | recovered `rolled_back` | before |
| `NATIVE_TX_BEFORE_COMMIT_INVOKE` | recovered `rolled_back` | before |
| `NATIVE_TX_AFTER_COMMIT_RETURN` | recovered `committed` | after |
| `NATIVE_TX_BEFORE_TERMINAL_APPEND` | recovered `committed` | after |
| terminal `CONTROL_STORE_APPEND_BEFORE_PUBLISH` | uninstalled candidate; recovered `committed` | after |
| terminal `CONTROL_STORE_APPEND_BEFORE_DIR_FSYNC` | installed exact terminal; clean, no duplicate | after |
| crash-only `NATIVE_TX_AFTER_TERMINAL_POSTCHECK` | clean, no duplicate | after |

Each fixture records only non-secret before/after business state, canonical TEXT seq, gate and event
evidence. Every row asserts the exact business before/after projection, seq, empty gate, unique
ControlStore successor/terminal and no duplicate terminal after a second clean reopen. The source
row additionally proves source-only recovery performs zero SQLite/append, then the harness appends
the caller-owned exact abandoned and the same cold facade reaches active with a fresh epoch.

Also freeze RED cases for clean/source-only/prepared factory classification, exact state/epoch
values, all recover return variants, clean recover idempotency, cold-facade method rejection and
fresh recovery epoch uniqueness. Every prepared crash point converges solely by
`beforeSeq`/`expectedFinalSeq` and exact predicates.

- [x] **Step 2: Implement recovery classifier and terminal completion**

Implement the cold classifier and caller-owned source cleanup contract without opening SQLite.
For prepared recovery, under the writer lease first validate canonical path, dbKey, ControlStore
exact tail and expected pathname/read-only file-handle identity without reading SQLite pages.
Open that exact path, then repeat pathname/handle identity, exact tail and lease checks before the
first SQLite statement that could recover a hot journal. Allow only that controlled connection to
recover; immediately afterward validate project instance, schema/backend, gate, seq, trigger
three-way state and identity against evidence, then mint a history-unique fresh epoch. Append and
post-check the exact recovery terminal before transitioning active. No business DML may run before
all post-recovery predicates pass. Never reuse pre-crash statements, transaction objects, guard or
facade.

- [x] **Step 3: Add corrupt/unknown disposition negatives**

Cover seq jump, non-empty gate, trigger three-way mismatch, instance/dbKey/identity mismatch,
same-path replacement plus hot journal (zero SQLite write/recovery to replacement), multiple
terminal successors and close/release uncertainty.

Also prove exact abandoned-only successor acceptance; wrong reason/source/epoch, an additional
successor, source tail drift and prepared terminal drift all remain cold/fail-closed. Assert the
stage-specific same-path error mapping, both pre-hot identity/tail/lease checks, zero statement on
the prepared mismatch path, pending read/write/checkpoint zero side effects and admission/suffix
errors staying `NATIVE_ADMISSION_REJECTED`.

- [x] **Step 4: Run GREEN, fixed review and commit**

```powershell
bun test ./server/tests/native-project-store.test.js ./server/tests/native-project-store-crash.test.js
git add server/native/native-project-store.js server/testing/fault-injection.js server/tests/native-project-store.test.js server/tests/fixtures/native-project-store-crash.js server/tests/native-project-store-crash.test.js
git commit -m "feat: recover native project transactions"
```

The independent fixed-commit review was closed by `4898482` (`fix: harden native recovery
boundaries`) without amending `27cf706`. The additional RED/GREEN matrix covers close/fence
operation-token ownership, delayed recovery-epoch minting, best-effort pre-statement cleanup,
prepared construction replacement mapping and admission-before-identity precedence. The final
counts above supersede the pre-review Task 4 counts.

### Task 5: Bounded ControlStore tail and legacy-compatible reader

> **Status: COMPLETE.** Initial implementation `3ce7d11`; fixed-review commit `7bbd7cb`;
> `bun test ./server/tests/control-store.test.js` fresh verification **105 pass / 0 fail**,
> including all six real `SIGKILL` rows. Final independent rereview: **Approve**
> (Critical 0, Important 0). Production schema remains 10, native activation remains off, and no
> installer, push, tag or release was run.

**Files:**
- Modify: `server/control-store.js`
- Modify: `server/testing/fault-injection.js`
- Modify: `server/tests/control-store.test.js`
- Modify: `server/tests/fixtures/control-store-crash.js`

**Interfaces:**
- `openControlStore(controlDir)` is byte-for-byte and interface-for-interface equivalent to exact
  `{bounded:false}`. Existing directories are classified before every possible write.
- Bounded `read()` returns only the active absolute suffix; bounded `tail()` returns
  `null|{seq,digest}`; `readEvidence()` returns the exact frozen three-key full evidence shape from
  the frozen contract above. Inspector outer/projection shapes do not change.
- Bounded facades retain `retire`/`retireAndActivate` method names but both are stable zero-write
  `CONTROL_STORE_PROTOCOL_UNSUPPORTED` before lease/filesystem/replay/validator work; default-v1
  retirement remains byte-for-byte unchanged.
- Default writer access to any bounded metadata is zero-write
  `CONTROL_STORE_PROTOCOL_UNSUPPORTED`. Bounded ambiguity uses the exact
  `RECOVERY_REQUIRED`/`CONTROL_STORE_CORRUPT`/`CONTROL_STORE_FENCED` mapping above.

- [x] **Step 1: Write RED for exact checkpoint/tail parsers**

Freeze exact-key JSON schemas, digest validation, incarnation binding, absolute seq, suffix
`prevDigest`, exact copied admission event and external verifier binding, cumulative counts,
non-serializable retry-closed capability boundary, monotone Bloom inheritance/canonical UUID/hash
positions/popcount cap, protocol error precedence, exact candidate names/content, unknown entry
rejection and `formalSha256` prohibition. Freeze both the full
`readEvidence()` object and the existing inspector projection.

- [x] **Step 2: Write RED for legacy compatibility**

No-checkpoint/no-tail v1 directories remain byte-identical after read/inspect. Bounded mode may
full-scan once to create a durable tail; default mode must not. After checkpoint GC, default mode
must identify bounded-v2 and reject without trying to replay from seq 1.
For both bounded retirement methods, snapshot the complete control directory plus lifecycle/active
metadata before the call, pass a validator that increments/throws, and assert the stable protocol
error, validator call count 0, no lease acquisition and an identical post-call tree. Cover tail-only
evidence now; the same prohibition remains binding after checkpoint support arrives.

- [x] **Step 3: Implement persistent tail and successor recovery**

Tail schema stores protocol epoch 2, checkpoint reference, covered seq/digest, tail seq/digest,
active event count/bytes and its own record digest, including the exact empty state. Each bounded
append publishes/fsyncs one event, atomically publishes/fsyncs tail and post-checks both before
return. Post-event uncertainty throws `RECOVERY_REQUIRED` once and fences that facade; only a
unique exact successor may advance a stale tail. Holes/multiple/wrong successor return
`RECOVERY_REQUIRED`; malformed metadata and a missing referenced checkpoint return
`CONTROL_STORE_CORRUPT`. Add multi-facade/CAS tests proving cached state never overrides the
persistent tail under the writer lease.

Table-drive installed-and-postchecked bootstrap/append with inner-writer and outer-lifecycle
release throws. Assert no receipt, first `RECOVERY_REQUIRED` with the first release cause preserved
and later failures in `secondaryErrors`, existing facade fenced, and a fresh bounded reopen sees one
exact install with no duplicate and the next absolute seq. Preserve the pre-publish/proven-cleanup
`CONTROL_STORE_IO` control row.

- [x] **Step 4: Add the six-row real-crash matrix**

Add the two frozen tail fault constants and make the existing crash worker select explicit
pure-v1 bootstrap or bounded append scenarios from non-secret environment input. Run both tail
points for bootstrap, both existing event points for bounded append and both tail points for
bounded append. Reopen only through the bounded writer under test; prove exact reconcile,
no duplicate and the next absolute seq.

- [x] **Step 5: Run GREEN, fixed review and commit**

```powershell
bun test ./server/tests/control-store.test.js
git add server/control-store.js server/testing/fault-injection.js server/tests/control-store.test.js server/tests/fixtures/control-store-crash.js
git commit -m "feat: add bounded control store tail evidence"
```

The fixed review was closed by `7bbd7cb` without amending `3ce7d11`. Its fresh rerun and the final
independent rereview supersede the pre-review Task 5 evidence above.

### Task 6: Checkpoint install, GC, pressure classification and epoch-2 cap

> **COMPLETE** — implementation commit `a4b9892` (`feat: add bounded checkpoint maintenance`).
> Fresh combined verification is **302 pass / 0 fail**; the real checkpoint `SIGKILL`, bounded
> append/bootstrap `SIGKILL`, legacy crash and durable-marker matrices are included in that accepted
> evidence. Formal independent review: **Approve C0/I0/M0**. No push, tag, installer or release was
> performed.

**Files:**
- Modify: `server/control-store.js`
- Modify: `server/testing/fault-injection.js`
- Create: `server/testing/bounded-control-store.js`
- Modify: `server/tests/control-store.test.js`
- Modify: `server/tests/fixtures/control-store-crash.js`
- Create: `server/tests/control-store-checkpoint.test.js`

Reuse the generic strong-kill fixture installed by Task 5; Task 6 creates no second checkpoint
worker fixture.

**Interfaces:**
- `server/control-store.js` owns a module-private
  `WeakMap<boundedFacade, checkpointController>`. The controller is never attached to the facade;
  therefore every Task 5 facade keeps the same `Reflect.ownKeys()` result. The module's three
  enumerable exports remain exactly `inspectControlStore`, `inspectControlStoreEvidence` and
  `openControlStore`.
- The sole Task 6 internal seam is a property installed on `module.exports` with this exact
  descriptor:

  ```js
  Object.defineProperty(module.exports, 'getBoundedControlStoreCheckpointController', {
    value: getBoundedControlStoreCheckpointController,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  ```

  `getBoundedControlStoreCheckpointController(facade)` accepts only the object identity of a
  bounded facade minted by that same loaded `control-store.js` module. A default facade, duck
  object, facade from a separately loaded module instance or any forged object is rejected before
  filesystem/lease/provider work with stable `CONTROL_STORE_PROTOCOL_UNSUPPORTED`. Repeated lookup
  returns the same exact frozen controller `{installCheckpoint,maintenanceStatus}`. Non-enumerable
  is API hygiene, not a security boundary: any trusted module able to read the property can invoke
  it, so the import graph is part of the contract.
- In Task 6, `server/testing/bounded-control-store.js` is the only non-test runtime module allowed to
  read/call that internal export. It exports exactly one enumerable function,
  `createBoundedControlStoreTestHarness(controlDir, authoritySource)`, and returns an exact frozen
  `{controlStore,checkpoint,maintenanceStatus}` wrapper. `checkpoint()` is zero-argument and calls
  the retained controller with a module-minted provider. `authoritySource` is an exact test-only
  zero-argument synchronous function (`typeof==='function'`, `length===0`); each `checkpoint()` that
  reaches provider evaluation invokes it exactly once and never outside the dual-lease turn. A
  throw or promise/thenable result follows the provider failure rules. The provider synchronously
  obtains synthetic/already-verified test data from `authoritySource`; `maintenanceStatus()` delegates to
  the retained controller. Neither controller, getter nor provider is returned or attached to
  `controlStore`. `server/tests/control-store-checkpoint.test.js` may inspect the descriptor and
  rejection behavior; no production/native module may call the getter in Task 6. Task 7 may add
  `server/native/native-project-store.js` as the second runtime caller, with dependency negatives;
  it must not import the test harness.
- Bounded `openControlStore()` owns startup reconcile. Before constructing the facade or registering
  its WeakMap controller, bootstrap takes lifecycle then writer lease and first read-only
  classifies/partitions checkpoint proposals. Checkpoint `TC` never reaches Task 5 ordinary
  tail-candidate reconcile; malformed/conflicting/mixed-invalid `P` fails zero-write before any tail
  advance. After the sole legal old-tail `P` is cleaned + directory-fsynced, or new-tail partial GC
  is completed, bootstrap runs Task 5 ordinary event-successor/tail-candidate reconcile and stably
  re-reads evidence. It returns a facade only after clean reconciliation and never calls provider.
- `installCheckpoint(authorityProvider)` accepts only that clean-reconciled facade and calls the
  zero-argument provider synchronously **exactly once**, while holding a new outer lifecycle and inner
  writer lease. Before provider evaluation it reruns the read-only classifier: an unreferenced event
  successor, any checkpoint proposal/tail candidate, or new-tail partial GC returns zero-write
  `RECOVERY_REQUIRED`, fences facade/controller and requires fresh bounded reopen. It never performs
  old-snapshot → reconcile → install in one controller turn. Only a clean result is stably re-read;
  then provider runs before any mutation for this new checkpoint. Its result
  is this recursively exact frozen data-only value:

  ```js
  {
    snapshot: {
      incarnationId,
      tail: { seq, digest },
      cleanBasisDigest,
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
      unresolved: [],
    },
    epochObservations,
  }
  ```

  Every object/array, including `admissionBasis`, its copied admission event/payload, `identity`,
  `unresolved` and `epochObservations`, must be `Object.isFrozen()`, have the exact own key set and
  only own enumerable data properties; object prototypes must be exact `Object.prototype`, array
  prototypes exact `Array.prototype`, and accessors, symbols, extra keys and thenables are forbidden.
  `epochObservations` is an exact frozen array of lowercase canonical
  UUID-v4 strings in covered-event order, one entry per authority-classified typed event, with
  duplicates retained. When the installation-time current checkpoint is `null`, observations cover
  `[1,newCoveredSeq]`; when it is non-null, they cover only
  `(currentCheckpoint.coveredSeq,newCoveredSeq]`.
- The installer requires `snapshot.incarnationId` and `snapshot.tail` to equal the persistent
  incarnation/tail re-read under both leases, and requires
  `snapshot.cleanBasisDigest === cleanBasis.latestCleanBasisDigest === current tail.digest` with a
  non-empty current tail. On repeated checkpoints, `cleanBasis.admissionBasis` must canonical-byte
  equal the previous checkpoint's basis and the core writes the previous basis unchanged. For an
  actual new install, the core also derives `previousCheckpoint`: exact `null` when the
  installation-time old persistent tail has no checkpoint, otherwise an exact field-by-field copy of
  that tail's `checkpointFile/checkpointDigest/coveredSeq/coveredDigest`; the new `coveredSeq` must be
  strictly greater. The core,
  not the provider, derives `coveredSeq/coveredDigest`, `chainRoot`, cumulative
  `eventTypeCounts`, previous-bits-OR-new-observations, `epochObservationCount`, exact
  `unresolved=[]` and `retryContinuationOpen=false`. Provider throw, promise/thenable, inexact
  shape, invalid observation or snapshot mismatch is stable `RECOVERY_REQUIRED`, zero writes and no
  receipt without an installed-state uncertainty fence; it is never `CONTROL_CHECKPOINT_BLOCKED`.
- For a repeated checkpoint with exact `activeEventCount===0` and
  `current tail.seq===previous checkpoint.coveredSeq`, provider validation still occurs exactly once.
  `epochObservations` must be exact `[]`; provider `cleanBasis` must canonical-equal the current
  checkpoint's exact clean-basis projection
  `{admissionBasis,dbKey,schema,backend,finalSeq,triggerVersion,triggerSetDigest,
  projectInstanceIdSha256,identity,latestCleanBasisDigest,unresolved}`. `snapshot` separately follows
  the current incarnation/tail/cleanBasisDigest rules above. The method triggers no fault point,
  performs no candidate/tail/GC write and, after
  both lease releases are known successful,
  returns the previous exact frozen `{checkpointDigest,coveredSeq}` as a no-op receipt. A newly
  installed repeated checkpoint must therefore have `newCoveredSeq > oldCoveredSeq`; empty active
  suffix is not blocked. If both current checkpoint and persistent tail are empty, no clean basis
  exists: provider/authoritySource is not called and install returns stable zero-write
  `CONTROL_CHECKPOINT_BLOCKED`.
- `maintenanceStatus()` exists only on the internal controller. Under the lifecycle lease it
  checks fenced first, then reuses the read-only classifier, performs no write and never calls the
  provider. Fresh open has already completed partial GC before minting the controller; if an exact
  unresolved candidate/orphan/successor or partial-GC state appears later, status returns
  `RECOVERY_REQUIRED`, while malformed metadata/referenced checkpoint missing/corrupt returns
  `CONTROL_STORE_CORRUPT`. It never reports a stale level. Only clean evidence returns exact
  frozen `{activeEventCount,activeEventBytes,level}`. Thresholds use count/bytes OR and are
  inclusive: `hard` when count `>=8192` or bytes `>=32 MiB`; otherwise `soft` when count `>=4096`
  or bytes `>=16 MiB`; otherwise `none`.
- Task 6 never adds pressure rejection to generic bounded `append()` or `compareAndAppend()`.
  An already admitted logical request, optional retry and its terminal must still cross soft/hard
  thresholds and close. Task 7 alone uses controller status at the outer logical-request boundary
  to delay the **next** admission and run the next exclusive maintenance turn.
- A successful install returns exact frozen `{checkpointDigest,coveredSeq}` only after checkpoint
  final and tail post-check, idempotent GC plus GC directory fsync, final verification, and both
  writer/lifecycle lease releases are all known successful. The controller constructs/inherits the
  fixed no-false-negative Bloom and enforces actual popcount `<=4,194,304` before final publish,
  tail commit or GC.

**Task 6 forbidden scope:** `server/native/**`, `server/project-write-coordinator.js`,
`server/db.js`, production open/write wiring, shutdown coordination, real native event parsing,
external admission reauthentication, logical retry closure and fresh-epoch Bloom-negative
admission. Those are Task 7 or later responsibilities.

- [x] **Step 1: Write internal seam and provider-validation RED**

Assert the exact non-enumerable/non-writable/non-configurable module descriptor, unchanged public
facade own keys/enumerable module keys, WeakMap object-identity admission, same-controller identity,
zero-write rejection of default/duck/separately-loaded facades and no controller/provider escape
from the exact test harness wrapper. Freeze `authoritySource` as test-only, zero-argument,
synchronous and at-most-once per checkpoint. Then table-drive provider throw, promise, accessor, symbol,
custom prototype, missing/extra key, mutable nested value, invalid UUID and persistent
incarnation/tail/clean-digest mismatch. Each row calls the source once under both leases and returns
`RECOVERY_REQUIRED` with a byte-identical directory and no receipt.

- [x] **Step 2: Write mechanical checkpoint/Bloom RED**

Freeze checkpoint schema, canonical digest, exact deep first admission basis copy, repeated
byte-identical basis inheritance and exact `previousCheckpoint` inheritance from the installation-time
old persistent tail (including a digest-change assertion for every descriptor field), cumulative
chain root/event counts, clean digest, absolute
coverage, previous-filter OR new-suffix inheritance, lowercase UUID normalization, duplicate
observation accounting, exact 1 MiB encoding, 50% popcount boundaries and the no-body/no-SQL/no-
`formalSha256` negative. These tests use only synthetic/already-verified observations from the
test harness. They do not parse native payloads, reauthenticate external admission, or claim real
provenance/completeness. Add the repeated active-suffix-zero row: provider exactly once, byte-identical
tree, exact `epochObservations=[]`, canonical-equal current checkpoint clean-basis projection with
the eleven fields frozen above, independently valid snapshot, no fault point, and previous
exact frozen no-op receipt after known-success releases. Add empty-store/no-current-checkpoint:
provider zero calls and stable byte-identical `CONTROL_CHECKPOINT_BLOCKED`.
In `server/tests/control-store.test.js`, update the Task 5 exact epoch-2 schema/parser regression:
fixtures carry `previousCheckpoint:null` or the exact four-key descriptor; reject missing/extra/
malformed filename-digest-seq relations and `previousCheckpoint.coveredSeq >= coveredSeq`,
but prove parsing succeeds when the mechanically valid descriptor's old final is already absent.

- [x] **Step 3: Implement no-clobber install, tail activation and receipt**

Use `wx → fsync file → hard-link final → unlink candidate → fsync dir → validate final →
replace tail → fsync dir → post-check → GC covered events/old checkpoint → fsync dir → final
post-check → release writer → release lifecycle`. Do not construct the success receipt until the
last release is known successful. `authorityMutationAttempted` remains false through checkpoint
final/candidate and tail-candidate write/fsync; after
`CONTROL_STORE_TAIL_BEFORE_PUBLISH` returns successfully, set it true immediately before tail
`atomicReplace`. Set `turn.installed=true` only after exact new-tail post-check. Before canonicalizing
a new checkpoint, set `previousCheckpoint=null` iff the installation-time old persistent tail has no
checkpoint; otherwise copy its exact `checkpointFile/checkpointDigest/coveredSeq/coveredDigest`
reference and require the new covered seq to advance strictly.

- [x] **Step 4: Add startup authority and fault matrix**

Freeze bounded-open bootstrap before facade/WeakMap minting. Under lifecycle then writer lease it
first read-only classifies/partitions checkpoint proposals. Let
`C=checkpoint candidate`, `F=hard-linked orphan final`, and `TC=checkpoint-tail candidate`; old-tail
proposal set `P` accepts only `{C}`, `{C,F}`, `{F}`, or `{F,TC}`. `{C,F}` requires exact hard-link
identity/canonical bytes; `{F,TC}` requires exact predecessor/final linkage. Valid pairs are jointly
deleted as one proposal (singletons likewise), followed by one
directory fsync; no provider, activation or GC is allowed. `TC` is consumed only by this classifier
and never by Task 5 ordinary tail-candidate reconcile. Malformed/conflicting/mixed-invalid `P` fails
zero-write before any event-tail advance. `P` classification is independent of any mechanically valid
`previousCheckpoint` carried by its proposal final and never follows that descriptor. Once persistent
tail references the new checkpoint, only its referenced final, covered-event residue and the exact
predecessor named by current `previousCheckpoint` are legal. A null descriptor permits no old final;
a non-null descriptor target may be absent as already GCed, or, if present, must be the sole
unreferenced final, pass the full exact checkpoint parser/digest, have its actual basename match
descriptor `checkpointFile`, and have parsed digest/covered seq/covered digest match the remaining
fields before deletion. Any extra exact final or valid mismatch is `RECOVERY_REQUIRED`; malformed final is
`CONTROL_STORE_CORRUPT`; the implementation never guesses by seq/name proximity. Bootstrap
idempotently finishes that GC and partial GC never
rolls tail back—but any checkpoint candidate in that new-tail scene preserves the Task 5 zero-write
`RECOVERY_REQUIRED` negative and is never cleaned. Tail-replace uncertainty is resolved only by
persistent tail. `TC` without `F`, mismatch, two simultaneous proposals `P`, multiple/conflicting
candidates or same-coveredSeq different digests return `RECOVERY_REQUIRED`; malformed candidate/final and referenced checkpoint missing/
corrupt return `CONTROL_STORE_CORRUPT`. Inspector maps every exact candidate/orphan to zero-write
`RECOVERY_REQUIRED`, malformed to `CONTROL_STORE_CORRUPT`, and never returns partial projection.
Only after legal proposal cleanup/new-tail GC does bootstrap run Task 5 ordinary event-successor/
tail-candidate reconcile and stable re-read. Assert bootstrap cleanup/GC success followed by lease
release failure throws `RECOVERY_REQUIRED` without returning a facade and converges only on fresh
reopen; zero-bootstrap-mutation release-only failure is `CONTROL_STORE_IO`.
Also prove an already-minted controller that later observes successor/proposal/partial-GC state
calls provider zero times, returns zero-write `RECOVERY_REQUIRED`, fences, and succeeds only through
a fresh bounded reopen that completes reconcile before minting a replacement controller.

Add all seven frozen checkpoint fault points and reuse both Task 5 tail points with exact
`operation:'checkpoint-activation'` context. Cover old-tail candidate/orphan cleanup, new-tail
idempotent GC, descriptor-present predecessor deletion, descriptor-absent already-complete GC,
null/extra/mismatch/malformed final fail-closed rows, partial event/old-checkpoint GC and every
uncertainty cut. For an old-checkpoint entry, assert the fault context basename is exactly
`currentCheckpoint.previousCheckpoint.checkpointFile`; an absent target emits no such deletion fault.

- [x] **Step 5: Add exact pressure, cap and error-cut tests**

Check 4,095/4,096/8,191/8,192 events and just-below/at 16/32 MiB. Hard maintenance failure
does not change generic append/CAS behavior: append a terminal across hard and observe controller
`level='hard'`. Test count/bytes OR and inclusive boundaries. Filter popcount exactly 50% succeeds;
the first candidate bit above 50% returns `CONTROL_CHECKPOINT_BLOCKED` before any final/tail/GC
mutation while preserving old checkpoint/tail/events. A pre-tail I/O failure is
`CONTROL_STORE_IO` only when the old tail remains authority and all candidate/orphan cleanup plus
directory fsync is exactly proven. Provider/snapshot failures and Bloom-cap failures are zero-write
primaries with no receipt and no installed-state uncertainty fence; release failures retain that
primary, use Task 5 `secondaryErrors` for Recovery primaries and `cleanupError` for non-Recovery
primaries. Empty-store blocked uses the same zero-mutation row. With no primary and zero mutation
(including a pending no-op receipt), release failure is `CONTROL_STORE_IO`. Freeze
`authorityMutationAttempted=false` through tail-candidate write/fsync and the
`CONTROL_STORE_TAIL_BEFORE_PUBLISH` callback; after that callback returns successfully, set true
immediately before tail `atomicReplace`. Assert tail-before-publish failure plus proven
cleanup is `CONTROL_STORE_IO`/no fence, while replace-attempt failure is
`RECOVERY_REQUIRED`/fence. Only `authorityMutationAttempted===true`, `turn.installed===true`, or checkpoint/tail/GC
mutation disposition unknown makes an operation or
release failure first-call `RECOVERY_REQUIRED`, fences facade/controller, returns no receipt,
preserves first `cause` identity and appends later failures to `secondaryErrors`; later operations
are `CONTROL_STORE_FENCED`. Never use
`CONTROL_CHECKPOINT_BLOCKED` to hide installed-state uncertainty.
Table-drive `maintenanceStatus()` fenced priority and the clean/recovery/corrupt classifier rows;
fresh-open partial GC completes before the replacement controller can return a level.

- [x] **Step 6: Run GREEN, diff check and commit**

Task 6 is complete only when the internal installer and test-only authority prove the mechanical
checkpoint/Bloom/tail/GC contract, including first-null/repeated-exact predecessor inheritance and
descriptor-only idempotent predecessor GC, without exposing an installer on the ordinary facade or
copying the native parser. Provenance from real native exact events remains an explicit Task 7
RED/GREEN.

```powershell
bun test ./server/tests/control-store.test.js ./server/tests/control-store-checkpoint.test.js
node --check server/control-store.js
node --check server/testing/bounded-control-store.js
node --check server/tests/fixtures/control-store-crash.js
git diff --check
git add server/control-store.js server/testing/fault-injection.js server/testing/bounded-control-store.js server/tests/control-store.test.js server/tests/fixtures/control-store-crash.js server/tests/control-store-checkpoint.test.js
git commit -m "feat: add bounded checkpoint maintenance"
```

### Task 7: Native checkpoint integration and aged-history evidence

**Files:**
- Modify: `server/control-store.js`
- Modify: `server/project-write-coordinator.js`
- Modify: `server/native/native-project-store.js`
- Modify: `server/testing/native-stage-b-store.js`
- Modify: `server/tests/project-write-coordinator.test.js`
- Modify: `server/tests/shutdown-coordinator.test.js`
- Create: `server/native/native-diagnostics.js`
- Create: `server/tests/native-diagnostics.test.js`
- Create: `server/tests/control-store-aged-history.test.js`
- Create: `server/tests/native-durability-benchmark.test.js`
- Modify: `docs/superpowers/plans/l1-benchmarks.md`

**Interfaces:**
- The Stage B testing entry remains `createStageBFixtureStore(fixture, options = {})`. Omitted
  `options`, or any dependency object with no `bounded` selector that is accepted by the current v1
  validation, keeps the current direct-facade return and byte/API behavior; bounded support does not
  tighten that old path. Any own/inherited/accessor `bounded` selector routes to bounded validation
  without invoking a getter and cannot fall back to v1.
  The bounded path is selected only by an exact `Object.prototype` data object with one of the two
  exact own-enumerable key sets
  `{bounded:true,coordinator}` or `{bounded:true,coordinator,sqliteFactory}`; `bounded:false`, an
  `assertWriterLease` override, a non-function `sqliteFactory`, custom prototype, accessors, symbols
  and every extra key are rejected with `NATIVE_ACTIVATION_DISABLED`.
  `project-write-coordinator.js` records every object returned by
  `createProjectWriteCoordinator()` in a module-private `WeakSet`. Its sole cross-module brand check
  is installed mechanically as
  `Object.defineProperty(module.exports,'isProjectWriteCoordinator',{value:
  isProjectWriteCoordinator,enumerable:false,writable:false,configurable:false})`; existing
  enumerable exports do not change. The factory calls that validator before filesystem/lease work,
  so duck objects and a
  coordinator minted by a separately loaded module instance are rejected. An accepted coordinator
  keeps the same `withProjectLogicalRequestSync`, `runPendingProjectMaintenanceSync` and
  `assertProjectWriteLease` function identities for the fixture lifetime.
- Initial bounded native construction itself runs inside
  `coordinator.withProjectLogicalRequestSync(fixture.databasePath,...)`. That new exclusive turn
  invalidates any older same-key pending job before work. Only while its callback-active dynamic
  slot holds that turn's `assertLease` and `registerPendingCheckpoint` does the factory open
  `openControlStore(controlDirectory,{bounded:true})`, pass the module-minted facade to native and
  construct the initial native facade. Construction calls `registerPendingCheckpoint` zero times,
  clears the slot in `finally`, and returns no wrapper unless the turn's release is known-success.
  It passes a checkpoint's exact copied `admissionBasis.admissionEvent` unchanged to the existing
  fixture verifier and never asks a default writer to open a bounded directory.
- The bounded call returns exact frozen test-only
  `{store,withProjectLogicalRequestSync}`. `store` has the ordinary frozen native facade keys and a
  zero-argument `checkpoint()`. `withProjectLogicalRequestSync(callback)` is a one-argument
  synchronous wrapper: it enters a new coordinator logical turn for `fixture.databasePath`, puts
  that callback context's dynamic capabilities in the private slot, invokes the user's
  zero-argument callback with no authority/context, and then performs the closure-private clean-turn
  pressure/job scheduling before clearing the slot in `finally`; after known-success turn release it
  returns the callback's exact non-thenable result. The wrapper is the only allowed
  caller of `registerPendingCheckpoint`: `none` calls it zero times, `soft` or `hard` exactly once;
  callback throw/thenable or a non-clean terminal calls it zero times. Coordinator does not and
  cannot identify a “native finalizer”; this is call-graph/API hygiene, not provenance authority.
  Job builder, basis, observations, lease/token, callback context and register function never
  escape. A nested same-key logical wrapper call throws `PROJECT_WRITE_REENTRANCY` with zero pending
  mutation; cross-key nesting follows the existing coordinator rule. Direct
  `store.executeTransaction()`, `store.recover()` or another lease-dependent method outside the
  active dynamic slot throws `PROJECT_WRITE_REENTRANCY` before SQLite/ControlStore mutation;
  zero-argument `store.checkpoint()` is the exception because it enters the maintenance runner
  itself.
- Native obtains Task 6's exact frozen `{installCheckpoint,maintenanceStatus}` controller only from
  the real bounded facade. It is the sole second runtime caller of the hidden getter; neither the
  controller, getter, provider nor coordinator capability escapes the native store closure.
  `server/testing/native-stage-b-store.js` may construct/pass the facade but never imports the
  getter. `server/testing/bounded-control-store.js` remains test-only and is never imported by
  native/coordinator/production code. Ordinary facade keys, the three enumerable
  `control-store.js` exports and the frozen public native facade keys stay unchanged.
- Bounded admission reads exact `readEvidence()`. With no checkpoint it authenticates the exact
  seq-1 fixture genesis and parses the whole active suffix as today. With a checkpoint it first
  reauthenticates `checkpoint.admissionBasis.admissionEvent` through the existing fixture verifier,
  then seeds an exact clean frontier from the checkpoint summary
  (`coveredSeq/coveredDigest,chainRoot,finalSeq,dbKey/schema/backend/triggerSetDigest,
  projectInstanceIdSha256/identity,latestCleanBasisDigest,eventTypeCounts,
  retryContinuationOpen=false`) and validates only the active absolute suffix beginning at
  `coveredSeq+1`/`coveredDigest`. It never treats the checkpoint as self-authenticating authority and
  never reads deleted covered event files.
- The checkpoint-aware parser accepts only a clean checkpoint frontier. The first post-checkpoint
  `manuscript.source` must be `attemptSeq=1,previousAttemptSourceDigest=null`; retries may then
  continue only from a source present in that same active logical-request suffix. It emits a
  recursively exact frozen `activeEpochObservations` array only after admission, native event
  schema, chain and state-machine validation: one lowercase canonical epoch for each typed event in
  the currently present active interval, in covered order, with duplicates retained.
  Legacy/generic same-name payload fields never contribute, and the parser never synthesizes an
  observation from checkpoint summary/Bloom data or rereads a GC-deleted event.
- **Task 7 verification boundary:** this private array and its provider do not gain an observer,
  query/export, controller/facade key, injectable controller or testing escape hatch. Runtime tests
  prove checkpoint-null/present interval membership, lowercase normalization, active/Bloom
  exclusion and legacy/generic/checkpoint exclusion; real checkpoint artifacts prove Bloom bits and
  cumulative `epochObservationCount`, including duplicate-per-event multiplicity. Covered order,
  exactly one post-validation lowercase push per typed event, recursive freeze and forwarding of the
  same private array are closed by a focused source review with exact lines/counterexamples and an
  independent C/I/M result. The Stage B acceptance ledger must record this combined evidence and
  state plainly that runtime tests cannot directly observe the private array's order.
- A bounded native facade retains a checkpoint-aware admitted frontier rather than a digest list of
  deleted history. After a successful/no-op checkpoint receipt it synchronously rereads exact
  evidence and live database/identity predicates, advances the private frontier to the installed
  checkpoint, clears the covered active prefix, and remains usable. A failed install does not
  advance it; only an uncertain/installed-state failure or an already fenced controller isolates the
  facade, while a known zero-write `CONTROL_CHECKPOINT_BLOCKED` does not. Provider creation happens
  only after exact clean terminal/live validation and returns Task 6's recursively exact frozen
  `{snapshot,cleanBasis,epochObservations}`. `epochObservations` is exactly the parser's current
  `activeEpochObservations`: installation-time checkpoint `null` means `[1,newCoveredSeq]` (including
  the active authenticated admission event), while non-null means
  `(currentCheckpoint.coveredSeq,newCoveredSeq]`. `latestCleanBasisDigest` is the current tail digest.
- Fresh epoch admission uses a native-module-private implementation of the frozen Task 6
  `sha256-domain-separated-v1` membership formula. It normalizes validated UUID-v4 values to
  lowercase before checking both the active exact used-epoch set and inherited checkpoint Bloom.
  It tries at most 128 newly generated UUIDs; an active-set hit or Bloom-positive candidate is
  discarded, and exhaustion returns `RECOVERY_REQUIRED` before SQLite activation/event append.
  Task 7 adds cross-check vectors against Task 6-created filters; the controller remains exactly
  `{installCheckpoint,maintenanceStatus}` and gains no query/export key.
- Coordinator adds exact synchronous APIs `withProjectLogicalRequestSync(projectKey,callback)` and
  `runPendingProjectMaintenanceSync(projectKey)`. Its internal logical callback context adds the
  capability `registerPendingCheckpoint(job)`; only the bounded wrapper receives that context and
  its user callback receives no arguments. `job` must be a recursively exact frozen data object
  `{snapshot,verifyCurrent,installCheckpoint}`; `snapshot` is exact frozen
  `{incarnationId,tail:{seq,digest},cleanBasisDigest}`, and both functions are own enumerable
  zero-argument synchronous functions. Accessors, symbols, custom prototypes, extra/missing keys,
  mutable nested values and thenables are rejected before staging.
- Inexact jobs and duplicate, late, leaked, stale or cross-project registration throw a private
  `TypeError` with code `PROJECT_CHECKPOINT_JOB_INVALID`. `registerPendingCheckpoint` returns
  `undefined` and is at-most-once in a logical callback: clean `none` makes zero calls and clean
  `soft`/`hard` makes exactly one. It is bound to the exact callback-active flag, batch, canonical
  key and ownership token; a captured call after callback return cannot alter pending state.
  Registration only stages the exact job identity. The coordinator publishes it to
  the per-canonical-key pending map only after callback success, final lease validation and
  known-success release. Callback throw/thenable or release/loss failure publishes nothing and
  preserves the existing primary/release error mapping.
- Starting any later same-key outer `withProjectWrite`, `withProjectWriteSync`,
  `withProjectRecoveryLeaseSync` or `withProjectLogicalRequestSync` invalidates the old pending
  identity before recovery/callback work, even when that turn later fails; initial bounded
  construction follows this same rule, and a successful logical turn may replace the invalidated job
  with its newly staged job. Canonical aliases count as the same key; different keys do not interact.
  A nested same-key `withProjectLogicalRequestSync` is rejected with
  `PROJECT_WRITE_REENTRANCY` before invalidation/staging; cross-key nesting follows the existing
  coordinator rule.
- `runPendingProjectMaintenanceSync` is an outer admission and therefore checks running state before
  canonicalization, lock, recovery or callback work. Missing, invalidated or already-consumed jobs
  return stable `CONTROL_CHECKPOINT_BLOCKED`; it never runs `recoverProject`. Admission rejection,
  `PROJECT_WRITE_BUSY` or any other lease-acquire failure happens before capture/consume and leaves
  the same pending identity available. After acquiring a new exclusive project writer lease it
  captures the pending identity and calls `verifyCurrent()` inside that newly owned writer context
  before consuming or mutating. A same- or cross-key public logical call attempted from verify is
  therefore nested and returns `PROJECT_WRITE_REENTRANCY` before pending invalidation/staging. After
  verify returns, the runner still rechecks that the exact map identity is current as
  defense-in-depth against future internal mutation; no current public API can replace it from
  verify, and Task 7 adds no private test seam for that unreachable case. If the defensive check ever
  observes a different identity, it preserves that identity, never calls the captured installer and
  returns stable `RECOVERY_REQUIRED`. False, throw or
  thenable from verify conditionally removes/invalidates only the captured job and never restores
  it; false/throw maps to `RECOVERY_REQUIRED` with cause identity retained, while thenable maps to
  `PROJECT_WRITE_ASYNC_CALLBACK`. Exact `true` plus a successful identity recheck permits atomic
  one-shot consume followed by `installCheckpoint()`. Any installer return, throw or thenable means
  that job has been consumed; lease loss/release uncertainty also never restores it. Synchronous
  non-thenable installer receipts/errors retain their identity except for the existing writer-lease
  loss precedence.
- A native pending job's `verifyCurrent` rereads exact ControlStore incarnation/tail/clean-basis
  digest plus database identity and live clean predicates. A foreign evidence/identity-changing
  turn therefore returns `RECOVERY_REQUIRED` with zero checkpoint/tail/GC/SQLite mutation, while a
  foreign operation that leaves all compared values exactly unchanged may proceed. The job's
  zero-argument installer invokes the retained Task 6 controller/provider and never reuses the
  released logical-turn ownership token.
- Pressure is evaluated only at outer logical-request boundaries. The already-admitted request owns
  attempt 1, optional attempt 2, its final retry decision and terminal before any maintenance can
  begin; generic bounded append/CAS is never pressure-blocked. After a successful clean terminal,
  `none` stages no job, `soft` replaces/coalesces to one current job, and `hard` also stages one job.
  No background thread is created in Stage B. `store.checkpoint()` is the sole explicit soft runner
  and means exactly `coordinator.runPendingProjectMaintenanceSync(fixture.databasePath)`. The
  wrapper retains only the current pressure level, never the job/basis. Before entering the next
  `withProjectLogicalRequestSync` callback it synchronously runs a current hard job through the same
  zero-argument store method; missing/stale/no-clean hard job or a Task 6 safe-cap failure returns
  `CONTROL_CHECKPOINT_BLOCKED` and the new callback/source never starts. A successful hard runner
  advances the native frontier, clears hard pressure and then admits the callback. Soft pending work
  never delays admission; a later same-key logical turn may replace it, and only an explicit
  zero-argument `checkpoint()` runs it.
- `beginQuiesce()` rejects new logical requests and pending-maintenance runners before path/lock/
  recovery work. It never starts pending maintenance, including hard work; an already-started runner
  remains an admitted batch that `drain()` waits to finish or fail. A merely pending job is not a
  batch and does not keep drain open. Shutdown below soft creates no job/checkpoint, and draining
  starts none. `server/tests/shutdown-coordinator.test.js` remains the exhaustive outer-admission
  contract for the two new APIs.
- `server/native/native-diagnostics.js` exports exactly one enumerable function,
  `projectNativeDurabilityDiagnostics(evidence)`. It is a shape-only projector: the caller must first
  authenticate the same evidence through the native admission/parser path, while this function only
  accepts a recursively exact frozen value matching the bounded `readEvidence()` schema and does not
  brand or establish provenance. It returns exact recursively frozen
  `{checkpoint,activeSuffix}` where `checkpoint` is `null` or exact
  `{checkpointDigest,coveredSeq}`, and `activeSuffix` is exact
  `{eventCount,eventBytes,tailSeq}` copied from that validated input's tail counters. It never returns paths,
  covered/active event payloads, Bloom data, admission/identity fields or mutable aliases. It is
  imported only by fixture tests; public RecoveryDiagnostics/REST/TypeScript DTO remain unchanged.
**Task 7 integration boundary:** this task, not Task 6, proves external admission
reauthentication, the real native parser's epoch provenance/completeness, same-logical-request retry
closure, fresh-epoch Bloom-negative + active-suffix-unused admission, hard-pressure scheduling and
the shutdown rule. It still must not modify `server/db.js`, production open/write wiring, schema
10/11 or activation mode; it must not expose the controller/provider or accept caller basis/token/
observations/`retryContinuationOpen`. Its exact tracked scope is the eleven files listed above:
no `server/testing/native-stage-b-fixture.js`, native crash fixture, public diagnostics/REST/TS DTO,
Task 8 acceptance/build-sidecar file, shutdown implementation or production coordinator wiring is
added implicitly.

- [ ] **Step 1: Write integration RED**

Only an exact clean native terminal may checkpoint. v1 automatic maintenance remains off;
quiescing/draining does not start non-essential maintenance. Maintenance runs only after the outer
logical request's closure-private writer turn has covered attempt 1, optional attempt 2 and the
final bounded retry decision. The first post-checkpoint source must start a new logical request
with `attemptSeq=1,previousAttemptSourceDigest=null`.

The integration RED must reauthenticate the checkpoint's exact copied admission basis with the
existing fixture verifier, prove runtime null/present interval membership, normalization and
legacy/generic/checkpoint exclusion, and prove shutdown below soft pressure creates no checkpoint.
It must not add an observation/provider observer seam. If maintenance already started, `drain()`
waits for its completion/failure; quiescing and draining start none.

Coordinator RED must freeze pending-job activation strictly after successful retry-turn lease
release, exact private job identity, invalidation/replacement by an intervening same-process turn,
and one-shot consume only after the next exclusive maintenance lease and read-only snapshot
revalidation. A two-coordinator/child counterexample must mutate tail/incarnation or database
identity after capture; the original zero-arg `checkpoint()` then returns `RECOVERY_REQUIRED` with
zero checkpoint/tail/GC/SQLite mutation. Foreign clean no-op, missing/stale/reused job and callback/
release failures must follow the exact semantics above and never install from caller-provided basis.
Integration runtime evidence also proves the real native parser is the sole source of
production-shaped observation consequences: active/inherited-Bloom membership, null/present
intervals and legacy/generic same-name exclusion before the pending checkpoint job is registered.
After a real install, exact Bloom bits and cumulative `epochObservationCount` prove completeness and
duplicate-per-event multiplicity. A focused source review separately proves the absolute-sequence
loop pushes one lowercase observation exactly once after each typed event validates, has no
Set/sort/dedup/reverse or generic/checkpoint/Bloom push path, uses a separate membership Set, freezes
the completed array and forwards that same private identity to the provider; an independent C/I/M
review closes this gate.

Add the exact bounded factory option/wrapper/brand negatives, inside-turn initial construction,
dynamic-slot/direct-call guard, zero/one registration cardinality, late/leaked/duplicate
registration, nested same-key rejection, acquire-failure retention, owned-verify logical reentrancy
plus the defense-in-depth identity recheck, missing/consumed `CONTROL_CHECKPOINT_BLOCKED`, thenable
mapping, same-key invalidation/
different-key isolation and the native-private Bloom cross-check/128 exhaustion table. Extend
`shutdown-coordinator.test.js` so its existing “all outer mutation” gate
includes logical request and maintenance runner; pending work is not silently started by quiesce or
drain.

- [ ] **Step 2: Add 0/10,000/100,000 aged-history RED**

Instrument file reads and prove append/recover cost depends on active suffix, not deleted
history. Verify cumulative event counts and chainRoot survive repeated checkpoints.

- [ ] **Step 3: Implement integration and internal diagnostics projection**

Run maintenance in the retry turn's next exclusive project writer turn using the same lock order;
never keep or reuse the released retry lease/ownership token. Only an uncertain/installed-state
failure or fenced controller isolates the fixture store; a known zero-write
`CONTROL_CHECKPOINT_BLOCKED` does not. No production project state is changed.

- [ ] **Step 4: Record Stage B performance without weakening old gates**

Use a dedicated `native-durability-benchmark.test.js` guarded by
`MYTHPEN_RUN_NATIVE_STAGE_B_BENCHMARK=1`. Run direct native save/checkpoint microbenchmarks with
2 warm-up + 20 measurements and nearest-rank p50/p95/max. Record results separately; do not
change the existing sql.js benchmark file, opt-in variable, fixtures or 300/500 ms failures.

- [ ] **Step 5: Run focused GREEN and commit**

Before the final commands, record the focused observation-source static review with exact source
lines, counterexamples and independent C/I/M approval. The acceptance ledger must map runtime
membership/interval/count/Bloom evidence and static order/exactly-once/freeze/provider-forwarding
evidence separately; it must not claim a direct dynamic observation of the private array.

```powershell
bun test ./server/tests/project-write-coordinator.test.js
bun test ./server/tests/control-store-aged-history.test.js
bun test ./server/tests/native-diagnostics.test.js
$env:MYTHPEN_RUN_NATIVE_STAGE_B_BENCHMARK = '1'
try { bun test ./server/tests/native-durability-benchmark.test.js } finally { Remove-Item Env:MYTHPEN_RUN_NATIVE_STAGE_B_BENCHMARK -ErrorAction SilentlyContinue }
git add server/control-store.js server/project-write-coordinator.js server/native/native-project-store.js server/testing/native-stage-b-store.js server/native/native-diagnostics.js server/tests/project-write-coordinator.test.js server/tests/shutdown-coordinator.test.js server/tests/native-diagnostics.test.js server/tests/control-store-aged-history.test.js server/tests/native-durability-benchmark.test.js docs/superpowers/plans/l1-benchmarks.md
git commit -m "test: prove bounded native durability history"
```

### Task 8: Stage B final gates and status update

**Files:**
- Modify: `docs/superpowers/plans/2026-08-06-l1-durability-foundation.md`
- Modify: `docs/superpowers/specs/2026-08-10-l1-durability-completion-design.md`
- Modify: `scripts/tests/build-sidecars.test.mjs`
- Create: `docs/superpowers/plans/l1-stage-b-acceptance.md`

**Interfaces:**
- Produces an auditable Stage B acceptance record.
- Does not mark activation, installer, tag or release complete.

- [ ] **Step 1: Run Stage B focused suites**

```powershell
bun test ./server/tests/durability-schema.test.js ./server/tests/native-project-store.test.js ./server/tests/native-project-store-crash.test.js
bun test ./server/tests/control-store.test.js ./server/tests/control-store-checkpoint.test.js ./server/tests/control-store-aged-history.test.js
bun test ./server/tests/project-write-coordinator.test.js ./server/tests/native-diagnostics.test.js
```

- [ ] **Step 2: Run repository gates**

```powershell
pnpm test:server
pnpm test:client
pnpm test:contracts
pnpm typecheck
pnpm lint
pnpm build
node --test scripts/tests/build-sidecars.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
git diff --check
```

- [ ] **Step 3: Write acceptance ledger**

Record exact commands, counts, fixture roots, schema/trigger digest, crash matrix, checkpoint
thresholds, aged-history reads, performance samples and every `NOT_RUN/DEFERRED` item. Explicitly
state production wiring remains off and no installer/tag/release was executed. For private
`activeEpochObservations`, record runtime membership/interval/count/Bloom evidence separately from
the focused static order/exactly-once/freeze/provider-forwarding review, and state that no direct
runtime observation of private array order exists or was introduced.
The build-sidecar contract must also prove the compiled dependency graph/binary contains none of
`sqlite.native.stage_b.fixture_genesis`, `createStageBFixtureStore`,
`server/testing/bounded-control-store.js`, `createBoundedControlStoreTestHarness` or either fixture/
checkpoint testing authority.

- [ ] **Step 4: Independent final review and commit**

```powershell
git add docs/superpowers/plans/2026-08-06-l1-durability-foundation.md docs/superpowers/specs/2026-08-10-l1-durability-completion-design.md docs/superpowers/plans/l1-stage-b-acceptance.md scripts/tests/build-sidecars.test.mjs
git commit -m "docs: record stage b native durability acceptance"
```

## Completion Boundary

Stage B 完成只表示 direct fixture NativeProjectStore、transaction recovery、schema 11
contract 和 bounded ControlStore 已通过。以下仍不得宣称完成：用户 schema 10 项目
activation、fixture/production activation、same-path adoption、真实 v0.0.7-v0.0.9
降级负控、production wiring、installer、tag、release 和完整 L1。
