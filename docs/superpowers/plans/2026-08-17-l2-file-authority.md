# L2 File Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 L1 原生耐久基线闭环后，把 Markdown/JSON 文件变成文章域唯一真值源，SQLite 仅作为可原子重建的活跃投影，并交付可恢复的写入、外部变化检测、迁移、草稿冲突与非破坏性退役。

**Architecture:** 所有文章写入收口到 `ManuscriptService`；`ManuscriptStore` 只理解安全路径、规范字节和文件闭包；`SQLiteProjectionStore` 只发布同一 generation 的完整投影；`ActiveManuscriptProjection` 是产品查询的唯一边界。Windows 普通会话以 shared lifecycle lease 保护，以三个 `ReadDirectoryChangesW` direct feed 维持新鲜度；写入、迁移、创建和草稿冲突分别由有父子所有权的 journal 状态机恢复。`project_meta.manuscript_route` 是路由真值，`config.db` 只保存可重建缓存。

**Tech Stack:** Bun 1.3.14、CommonJS 服务端、`bun:ffi`/Win32、NativeProjectStore/SQLite、Express、React 19 + Zustand + TypeScript、Tauri 2/Rust、Bun test、Node test、Biome。

## Global Constraints

- 实施依据是 `docs/superpowers/specs/2026-08-15-l2-file-authority-spec.md` 第 2.12 版；若计划与规范冲突，以规范为准并先修订计划。
- 第 2.12 版保留第 2.10 版门禁调度，并只补齐 FilePublicationJournal 可执行合同：允许 L2 correctness implementation 在 native p95 production evidence 前先行，但 `files` 始终保持实验性、非默认且不得称为 `DEFAULT_READY`；native p95 与全部 source-bound evidence 仍必须在 Task 17B 最终验收中通过。
- L2 开工只依赖 Task 1A 的 schema 11 安全准入、本地 contract 与 regression 基线；尚未闭环的 L1 production p95 和 source-bound Windows evidence 不阻塞 Task 2，统一延后到最终 L2 source 冻结后验收。
- 不创建 Git 仓库，不实现 L3/L4，不双写 SQLite 和文件，不搬迁数据根，不物理删除 `files` 项目。
- 每个产品任务都先写失败测试，再写最小实现，再跑聚焦测试；每个任务只提交列出的作用域，提交前运行 `git diff --check`。
- 从 Task 11A 起，每项只允许一次 readiness 与一次 final review；final review 未发现 Critical/Important 时禁止继续扩测试矩阵或做无关重构。相关计划修订合并提交，不为每个 wording 调整单独制造 docs-only commit。
- 所有文件路径只能由已验证的规范 UUID 推导；调用者不得传相对路径、文件名、glob 或目录映射。
- 权威树固定为 `mythpen/`、`mythpen/volumes/`、`mythpen/chapters/` 三个目录与五种文件形状。
- L2 v1 上限固定为：章节身份 10,000、卷身份 2,000、Markdown 16 MiB、JSON 256 KiB、受控文件 25,000、`chapters/` 目录项 20,000、原始字节 1 GiB；80% 身份用量必须持续预警。
- 正确性状态与默认启用状态分离：先达到 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，再凭实测达到 `DEFAULT_READY`。
- 未运行的门禁只能记为 `NOT_RUN` 或 `DEFERRED`，不能写成通过。
- Task 1A、Tasks 2–16 与 Task 17A 开发期只跑 focused/local/fixture/debug/fault tests；全文只有 Task 17B 可在全部 production source（含默认路由决策）提交并冻结后运行一次完整 L1 VM 13/19、L2 final matrices 与 production acceptance。freeze 后只允许 evidence/docs diff；任何 production source 变化都必须回到新的本地 preflight，不能沿旧 raw 重跑。

## Dependency Gates

```text
Stage 0: Task 1A 安全建立 schema 11/native 基线
  └─ Task 2: 固定 L2 合同与 schema 12 离线描述
          ├─ Task 3: ManuscriptStore
          ├─ Task 4: 纯只读 ActiveManuscriptProjection
          Task 3 + Task 4
              └─ Task 5: SQLiteProjectionStore
          Task 3 + Task 5
              └─ Task 6: FilePublicationJournal
                  └─ Task 7A: 最小文件闭包编译器与纯 UID reservation core
                      └─ Task 7B: ordinary/full 非创建写编排
          Task 6
              ├─ Task 8A: Windows existing-file lifecycle lease adapter
              └─ Task 8B: session admission state machine
          Task 6
              ├─ Task 9A: Windows direct-feed platform adapter
              └─ Task 9B: linearizable feed-state
          Task 3 + Task 4 + Task 5 + Task 6 + Task 8A + Task 8B + Task 9A + Task 9B
              └─ Task 9C: freshness/session lifecycle
          Task 7B + Task 9C
              └─ Task 9D: admission/freshness wrapper
          Task 2 + Task 3 + Task 5 + Task 7B
              └─ Task 10A1: ignored ledger 规范化、Store observation 与 compiler
          Task 7B + Task 10A1
              └─ Task 10B1: ignored-aware serializer、非创建结构命令与 opaque reference 动作
          Task 6 + Task 7A
              └─ Task 10B2: ordinary journal request lookup、reservation read/assert/source
          Task 10B1 + Task 10B2
              └─ Task 10B3: ordinary create reservation 编排与结果重放
          Task 9D
              ├─ Task 11A: server DraftConflictJournal core
              ├─ Task 11B: client dirty-resource registry core
              └─ Task 12: MigrationJournal
                      └─ Task 13: ProjectCreationJournal
          Task 9D + Task 10A1 + Task 12
              └─ Task 10A2: projection-only ignore/revoke（后移）
          Task 10P: 本计划固定 omitted；若 Task 17A 最终性能证据要求增量刷新，另立新计划，禁止回填本 composition
          Task 9C + Task 9D + Task 10A1 + Task 10A2 + Task 10B1 + Task 10B2 + Task 10B3 + Task 11A + Task 12 + Task 13
              └─ Task 14: 退役/重激活/换根屏障
          Task 9C + Task 9D + Task 10A1 + Task 10A2 + Task 10B1 + Task 10B2 + Task 10B3 + Task 11A + Task 12 + Task 13 + Task 14
              └─ Task 14B: 最终产品 API/CLI/读写入口接线
                  └─ Task 15: UI/诊断/宿主文件入口
          Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7A + Task 7B + Task 8A + Task 8B + Task 9A + Task 9B + Task 9C + Task 9D + Task 10A1 + Task 10A2 + Task 10B1 + Task 10B2 + Task 10B3 + Task 11A + Task 11B + Task 12 + Task 13 + Task 14 + Task 14B + Task 15
              └─ Task 16: 本地正确性 join/harness freeze（不发布 production evidence）
                                      └─ Task 17A: 可选最小性能 preflight 与默认路由 go/no-go（非 acceptance）
                                          └─ Task 17B: 无条件冻结 capability build-info，按 go/no-go 落地默认决策并完成唯一一次 production artifact 验收
```

---

## Task 1A: 安全建立 schema 11/native 生产基线

**Files:**

- Modify: `server/db.js`
- Modify: `server/native/native-activation-controller.js`
- Modify: `server/routes/api.js`
- Modify: `server/tests/durability-schema.test.js`
- Modify: `server/tests/native-activation.test.js`
- Modify: `server/tests/native-db-adapter.test.js`
- Modify: `server/tests/production-native-activation-controller.test.js`
- Modify: `server/tests/project-db-existence.test.js`
- Modify: `server/tests/fixture-native-sidecar-e2e.test.js`
- Modify: `scripts/tests/build-sidecars.test.mjs`
- Modify: `scripts/tests/l1-production-e2e.test.mjs`

**Interfaces:**

```js
// server/db.js
// 最高可识别/接纳的项目 schema；不等于 sql.js migration target。
const PROJECT_SCHEMA_VERSION = 11;
const SQLJS_PROJECT_SCHEMA_VERSION = 10;
const NATIVE_ACTIVATION_SOURCE_SCHEMA_VERSION = 10;

// server/native/native-activation-controller.js
// 每次 schema 11 admission 都重验 registry 私有品牌和当前 compiled mode。
function assertNativeActivationControllerForBuild(controller) {}

// server/db.js + server/routes/api.js
// route 只转交已做形状校验的 expected instance；实现必须先在 closed DB 上
// 只读核验 exact schema 10 + instance，再允许 open/activate。
async function enableNativeProject(name, expectedInstanceId) {}

// scripts/tests/build-sidecars.test.mjs
function windowsPowerShellSelfTestEnvironment(sourceEnvironment) {}

// scripts/tests/l1-production-e2e.test.mjs
function assertAttestedInputs() {
  assertFrozenProductionSource();
  // only then read/execute the explicitly supplied candidate and manifest
}
```

- [ ] 把 live `pnpm test:contracts` 在 manuscript scanner 前的 `32 pass / 2 fail / 2 skip` 记为 Task 1A 必须关闭的 RED 基线；两个 failure 只能通过下列 SelfTest child-env 边界与 E2E attested-input 边界修复，不得跳过测试、改 PowerShell smoke 或重写历史 artifact 常量。
- [ ] 在 `build-sidecars.test.mjs` 实现小型 `windowsPowerShellSelfTestEnvironment(sourceEnvironment)` helper：新建 child environment 副本，删除每一个 `key.toLowerCase() === "psmodulepath"` 的 key，其他 key/value 逐项原样保留。unit test 同时放入 `PSModulePath` / `PSMODULEPATH` / `psmodulepath` 和 sentinel 变量，断言输入对象未变、输出是新对象、所有大小写别名都缺失且 sentinel 不变。只把该输出作为 Node 启动 Windows PowerShell 5.1 `desktop-lifecycle-smoke.ps1 -Mode SelfTest` 的 `spawnSync(..., { env })`；不修改全局 `process.env`，不对 Bun/compiler/sidecar 或其他 child spawn 使用该 sanitizer，不改写 PowerShell smoke 脚本。SelfTest 必须恢复 PASS，且其他 case 仍为 `NOT_RUN`。
- [ ] 在 `l1-production-e2e.test.mjs` 把唯一一次 `assertFrozenProductionSource()` 调用从普通 compiled missing-manifest 负例移到 `assertAttestedInputs()` 的第一步。只有显式同时提供 `MYTHPEN_L1_PRODUCTION_CANDIDATE` 和 `MYTHPEN_L1_REVIEWED_MANIFEST` 而进入 acceptance tests 时，才在读取/执行 candidate 或 manifest 前强制 source ancestry/diff freeze；普通 missing-manifest 负例不消费 attested artifact，必须继续编译未授权 production sidecar，返回 fail-closed 并逐字节证明 SQLite/activation evidence 零修改。
- [ ] 不设 candidate/manifest env 时，`l1-production-e2e.test.mjs` 必须精确为 `1 pass / 0 fail / 2 skip`。显式传入历史 `f3641a2f0e1da237ce900e04547556f72ae5457e` candidate 与 reviewed manifest 时，必须在读取/运行 artifact 前因该 source 不是当前 HEAD ancestor（或 object 已不可解析）而非零 fail-closed。Task 1A 不得把 `sourceCommit` 换成 squash SHA 却保留旧 candidate/manifest hashes，不得 allowlist ancestry，不得把旧 candidate 重新称为 PASS/verified。
- [ ] 新增失败测试：把 `PROJECT_SCHEMA_VERSION` 提到 11 后，普通 sql.js create/open 不得因 `runMigrations()` 缺少 `projectMigrations[10]` 而只写 `schema_version=11`。
- [ ] 让 `runMigrations()` 遇到缺失 migration step 时 fail-closed；`migrateProject()` 明确只迁移到 `SQLJS_PROJECT_SCHEMA_VERSION=10`，源码/off 项目继续保持完整 schema 10，不生成任何 schema 11 marker。
- [ ] 先写 route-order RED：`POST /projects/by-name/:name/durability/native` 不得先调用会隐式 `assertProjectInstance/openProjectDb/migrateProject` 的路径。route 只校验 query/body/header 形状，再把原始项目名与必填 expected instance ID 一次性交给 `enableNativeProject(name, expectedInstanceId)`；schema 9/11/12、错误 instance、同进程重复 activation 与重启后重复 activation 都必须在任何 open/migration、ControlStore append 或数据库写入前拒绝，并逐字节证明 DB/ControlStore 零修改。
- [ ] `enableNativeProject()` 必须在 config lifecycle lease 与同项目 writer lease 内、任何 sql.js/native connection 或 migration 前，对 closed database 只读核验 registry path、schema **精确等于 10**、`project_instance_id` 等于 request header；之后才可经既有 native activation transaction 一次安装 backend、空 gate、54 个 canonical triggers、trigger version/digest 和 schema 11。不得用 sql.js migration runner安装其中任何一项，也不得先 open 再回看 source schema。
- [ ] 每次 schema 11 admission（同进程 cached connection、cold restart、startup）都重新调用 `native-activation-controller.js` 的 registry 私有品牌校验并读取当前 compiled build mode；只接受 matching production controller+production build 或 matching fixture-only controller+fixture-only build，再联合核对 activated evidence/backend/空 gate/54 triggers/version/digest。`off`、duck/clone、跨 mode/mismatch、prepared-only 或残缺 contract 均在业务读取/DML 前 fail-closed，不缓存一次成功 boolean。
- [ ] startup 必须先运行 L1 V1 publication recovery diagnostics，再做 formal path/project identity/schema admission；schema 10 的 missing-formal 或未终结但可恢复 publication 必须保留精确 `V1_PUBLICATION_*_RECOVERABLE` 与 recommended action，不能被提前改写为 `PATH_UNREADABLE`/`NOT_PROJECT`。diagnostics 排除/收敛现场后，才对 schema 11 与 `>11` 做联合 admission；`>11` 在 open/migration/recovery/DML 前返回 `PROJECT_SCHEMA_TOO_NEW` 且 DB/ControlStore 零修改。
- [ ] 扩展 `durability-schema.test.js` 的版本无关 downgrade guard 负控：从 production canonical generator 派生全部可写表和 INSERT/UPDATE/DELETE，断言无内部 capability 的连接全部被拒绝且关闭连接后数据库与 ControlStore 字节不变；不新增 v0.0.7–v0.0.9 夹具，并把这组断言计入 schema 11 基线门禁而非独立历史版本门禁。
- [ ] 正负断言覆盖 schema 10 普通写、正式 activation 完整 schema 11 contract、schema 9/11/12 source、错误 instance、残缺 schema 11、同进程/重启重复 activation、off/duck/clone/production↔fixture-only mismatch 与 runtime-mode 旁路；`project-db-existence.test.js` 另加 missing-formal startup integration，逐项断言 recoverable code/recommended action 与恢复前零误分类。
- [ ] 运行聚焦验证：

```powershell
bun test server/tests/durability-schema.test.js server/tests/native-activation.test.js server/tests/native-db-adapter.test.js server/tests/project-db-existence.test.js
bun test --timeout 30000 server/tests/production-native-activation-controller.test.js
bun test --timeout 120000 server/tests/fixture-native-sidecar-e2e.test.js
node --test --test-name-pattern "Windows PowerShell SelfTest child|desktop lifecycle smoke SelfTest" scripts/tests/build-sidecars.test.mjs
Remove-Item Env:MYTHPEN_L1_PRODUCTION_CANDIDATE, Env:MYTHPEN_L1_REVIEWED_MANIFEST -ErrorAction SilentlyContinue
node --test scripts/tests/l1-production-e2e.test.mjs # 必须精确 1 pass / 0 fail / 2 skip
$env:MYTHPEN_L1_PRODUCTION_CANDIDATE = (Resolve-Path -LiteralPath '.\src-tauri\target\production-sidecars\mythpen-server-production-x86_64-pc-windows-msvc.exe').Path
$env:MYTHPEN_L1_REVIEWED_MANIFEST = (Resolve-Path -LiteralPath 'D:\Mythpen\l1-vm\evidence\windows-l1-reviewed-manifest.json').Path
node --test scripts/tests/l1-production-e2e.test.mjs # 必须非零，报告旧 f364... source 非 HEAD ancestor/object 不可解析，不得进入 candidate
$oldCandidateExit = $LASTEXITCODE
Remove-Item Env:MYTHPEN_L1_PRODUCTION_CANDIDATE, Env:MYTHPEN_L1_REVIEWED_MANIFEST -ErrorAction SilentlyContinue
if ($oldCandidateExit -eq 0) { throw 'Historical L1 candidate was incorrectly accepted' }
```

- [ ] 只跑 Task 1A focused/contract 回归并提交可独立审查的检查点；全量 server/client/typecheck/build 统一后移到 Task 16：

```powershell
Remove-Item Env:MYTHPEN_L1_PRODUCTION_CANDIDATE, Env:MYTHPEN_L1_REVIEWED_MANIFEST -ErrorAction SilentlyContinue
bun test server/tests/durability-schema.test.js server/tests/native-activation.test.js server/tests/native-db-adapter.test.js server/tests/project-db-existence.test.js
bun test --timeout 30000 server/tests/production-native-activation-controller.test.js
bun test --timeout 120000 server/tests/fixture-native-sidecar-e2e.test.js
node --test --test-name-pattern "Windows PowerShell SelfTest child|desktop lifecycle smoke SelfTest" scripts/tests/build-sidecars.test.mjs
node --test scripts/tests/l1-production-e2e.test.mjs # 必须精确 1 pass / 0 fail / 2 skip
git diff --check
git add server/db.js server/native/native-activation-controller.js server/routes/api.js server/tests/durability-schema.test.js server/tests/native-activation.test.js server/tests/native-db-adapter.test.js server/tests/production-native-activation-controller.test.js server/tests/project-db-existence.test.js server/tests/fixture-native-sidecar-e2e.test.js scripts/tests/build-sidecars.test.mjs scripts/tests/l1-production-e2e.test.mjs
git commit -m "fix: establish safe schema 11 native baseline"
```

**Stop condition:** 普通 sql.js 能制造残缺 schema 11、activation REST 在 closed DB 只读核验 exact schema 10 + expected instance 前触发 open/migration、schema 9/11/12 或重复 activation 产生修改、schema 11 admission 未每次重验 controller brand/build mode/完整 contract，或 startup 在 V1 diagnostics 前把 recoverable missing-formal 误分类时停止。Windows PowerShell SelfTest child env 仍含任意大小写的 `PSModulePath`、sanitizer 修改 `process.env`/丢失其他变量，无 candidate env 的 E2E 不是 `1 pass / 0 fail / 2 skip`、missing-manifest 现场有修改，或旧 candidate/manifest 未因 source ancestry/object 失配而 fail-closed，也立即停止。Task 1A 只提交 live contract 与本地回归基线；不得构建或接纳新 production candidate/result，这些统一延后到 Task 17B。

---

## Task 2: 固定 L2 合同、错误码与 schema 12 离线描述

**Depends on:** Task 1A 的本地 schema/controller/startup contract；不依赖 native p95、VM 13/19 或 production candidate。

**Files:**

- Create: `server/manuscript/contracts.js`
- Modify: `server/native/durability-schema.js`
- Create: `server/tests/manuscript-contracts.test.js`
- Create: `server/tests/manuscript-schema-12.test.js`

**Interfaces:**

```js
// server/manuscript/contracts.js
const MANUSCRIPT_FORMAT_VERSION = 1;
const MANUSCRIPT_SCHEMA_VERSION = 12;
const ROUTES = Object.freeze(["sqlite", "migrating", "files", "retired"]);
const RESERVED_PROJECT_META_KEYS = Object.freeze([
  "manuscript_route",
  "manuscript_project_uid",
  "manuscript_route_journal",
  "manuscript_projection_generation",
]);
const OBJECT_CLASSES = Object.freeze([
  "controlled",
  "orphan",
  "journal_candidate",
  "uncontrolled_residue",
]);
const LIMITS = Object.freeze({
  chapterIdentities: 10_000,
  volumeIdentities: 2_000,
  markdownBytes: 16 * 1024 * 1024,
  jsonBytes: 256 * 1024,
  controlledFiles: 25_000,
  chapterDirectoryEntries: 20_000,
  controlledBytes: 1024 * 1024 * 1024,
});
const ERROR_CODES = Object.freeze([
  "MANUSCRIPT_PATH_UNSAFE",
  "MANUSCRIPT_FILESET_INVALID",
  "MANUSCRIPT_FORMAT_TOO_NEW",
  "MANUSCRIPT_CONTENT_TOO_LARGE",
  "MANUSCRIPT_TARGET_LOCKED",
  "UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE",
  "EXTERNAL_CHANGE_CONFLICT",
  "EXTERNAL_DRAFT_CONFLICT",
  "EXTERNAL_RESOURCE_CREATION_UNSUPPORTED",
  "IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE",
  "MANUSCRIPT_TREE_CHANGED_DURING_READ",
  "PROJECTION_STALE",
  "MANUSCRIPT_LIFECYCLE_UNAVAILABLE",
  "PROJECT_MIGRATION_BUSY",
  "LEGACY_CHAPTER_NUMBER_INVALID",
  "LEGACY_FORESHADOW_EXPECTED_POSITION_AMBIGUOUS",
  "LEGACY_FORESHADOW_EXPECTED_POSITION_INVALID",
  "SCHEMA_SWAP_UNSUPPORTED",
  "PROJECT_SCHEMA_TOO_NEW",
  "MIGRATION_STATE_MISMATCH",
  "UID_RESERVATION_COLLISION",
  "PROJECT_PERMANENT_DELETE_UNSUPPORTED",
  "NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED",
  "RECOVERY_REQUIRED",
]);
function manuscriptError(code, details = {}, cause) {}
function assertCanonicalUuid(value, role) {}
module.exports = { MANUSCRIPT_FORMAT_VERSION, MANUSCRIPT_SCHEMA_VERSION, ROUTES, RESERVED_PROJECT_META_KEYS, OBJECT_CLASSES, LIMITS, ERROR_CODES, manuscriptError, assertCanonicalUuid };
```

- [ ] 写失败测试覆盖全部稳定错误码、四种 route、四个保留 `project_meta` 键、四种对象分类和全部容量常量。
- [ ] 保持 schema 11 的 v1 writable-table manifest、18 表/54 canonical triggers、`TRIGGER_VERSION=1`、expected digest、inspector 与 installer **逐字节兼容且测试值不变**；不得放宽 v1 canonicalizer，也不得让 schema 11 按 v2 描述复核。
- [ ] 在 `durability-schema.js` 新增只读 `SCHEMA12_CONTRACT`、`schema12CanonicalTriggerDefinitions()`、`schema12CanonicalTriggerSetDigest()` 与 `inspectSchema12Contract()`。该 descriptor 精确冻结第 7 节要求的 v2 writable manifest、卷/章节 UID 与 tombstone/position/raw-hash 字段、ignored ledger、受控文件与容量快照、projection generation、伏笔 position、RESTRICT、物理 DELETE barrier 和两个活跃编号部分唯一索引；trigger version 固定为 2，并与 v1 使用互不混用的 expected digest。
- [ ] `manuscript-schema-12.test.js` 只构造内存 inspection surface，验证 v2 代码 expected、`project_meta` 与 observed schema/trigger digest 三方一致；缺失、额外、语义变化与 v1/v2 跨版本混用全部 fail-closed。这里不创建磁盘 candidate，不迁移业务行，也不声称 production 可打开 schema 12。
- [ ] `PROJECT_SCHEMA_VERSION` 保持 11，`SQLJS_PROJECT_SCHEMA_VERSION` 保持 10；普通 open 继续用 Task 1A 的既有门禁把 schema 12 当作 `PROJECT_SCHEMA_TOO_NEW` 零修改拒绝。Task 12 只有在 populated candidate installer 和持久 transition admission 同时成立后才把支持上限提升为 12。
- [ ] 本任务不提供 schema 12 candidate builder/installer，不生成 UID，不修改 `db.js`、`NativeProjectStore`、SQL authorization、fixture 或静态扫描。Task 12 建立唯一 builder 处理带 frozen UID/projection 的 populated migration candidate；Task 13 对空项目复用同一 builder，禁止第二套 empty-candidate DDL 路径。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-contracts.test.js server/tests/manuscript-schema-12.test.js server/tests/durability-schema.test.js
git diff --check
git add server/manuscript/contracts.js server/native/durability-schema.js server/tests/manuscript-contracts.test.js server/tests/manuscript-schema-12.test.js
git commit -m "feat: define L2 contracts and schema 12"
```

---

## Task 3: 实现安全路径、规范格式、容量计量与 ManuscriptStore

**Depends on:** Task 2。

**Files:**

- Create: `server/manuscript/paths.js`
- Create: `server/manuscript/format.js`
- Create: `server/manuscript/capacity.js`
- Create: `server/manuscript/store.js`
- Create: `server/tests/manuscript-paths.test.js`
- Create: `server/tests/manuscript-format.test.js`
- Create: `server/tests/manuscript-capacity.test.js`
- Create: `server/tests/manuscript-store.test.js`
- Create: `server/tests/fixtures/manuscript-tree.js`

**Interfaces:**

```js
function deriveManuscriptPaths({ dataRoot, projectUid }) {}
function deriveVolumePath(paths, volumeUid) {}
function deriveChapterPaths(paths, chapterUid) {}
function deriveControlledFileRef({ role, projectUid, volumeUid, chapterUid }) {}
function classifyTreeEntry({ directoryRole, actualName }) {}
function createDirectoryNameIndex({ paths, directoryRole, parentIdentity, scanEpoch, actualNames }) {}
function parseCanonicalJson({ role, bytes, expectedUid }) {}
function serializeCanonicalJson(role, value) {}
function inspectMarkdown(bytes) {}
function createCapacityAccumulator(limits, observer) {}

class ManuscriptStore {
  constructor({ dataRoot, fileBoundary, journalAuthority, limits, capacityObserver }) {}
  async enumerateAndClassify(identity) {}
  async validateFull(identity, { ignoredLedger, lifecycleBasis }) {}
  async readControlledFile(identity, controlledFileRef) {}
  async buildProjectionCandidate(snapshot) {}
}
```

- [ ] 写路径合同测试：只接受规范小写 UUID；每个目录只枚举一次并建立 module-branded name index，在线性时间内校验实际实名逐字节相等、case-fold/NFKC/尾随点空格无碰撞，并把 index 绑定到同一 paths、目录物理身份和 scan epoch；逐文件身份复核只能 O(1) 消费该 index，plain clone、跨目录和跨 epoch token 全部拒绝。目录/文件非 reparse、普通文件 link count=1、规范 real path/物理身份稳定由注入的 opaque file boundary 合同提供。
- [ ] `controlledFileRef` 只能由 `role = manuscript | unassigned | volume_index | chapter_body | chapter_sidecar` 加已经通过 `assertCanonicalUuid` 的 project/volume/chapter UID 构造，或者使用模块内部 branded reference；`readControlledFile()` 及所有调用方不得接收、拼接或透传相对路径、文件名、glob 或目录映射。负向测试把看似规范的 caller path、分隔符别名和错误角色/UID 组合全部拒绝。
- [ ] 固定目录布局与五种规范形状；识别 `<canonical>.<journal_id>.tmp` 为 journal candidate；孤儿与非受控残留分开，残留不读、不哈希、不改、不删。
- [ ] 实现四类 JSON 的稳定键序、UTF-8 无 BOM、LF、两空格、末尾单换行、未知字段拒绝、重复 UID/成员拒绝、`format_version` 过高专门报错。
- [ ] Markdown 先对 raw bytes 做 SHA-256，再验证 UTF-8；检测器精确识别可视方言：普通段落、一级/二级标题、粗体、斜体、下划线、行内代码、三反引号围栏代码块与 `---` 分隔线。合法 UTF-8 只要包含该方言之外构造就标记为 `read_only_passthrough`：查看、复制、导出与 sidecar/卷元数据写仍允许，AI 续写、提案应用、自动保存和其他语义性整篇正文写统一返回 `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE`，且不得重写 `.md`。含 U+0000 的合法 UTF-8 同样只读透传，投影 `chapters.content` 置空并标记不可用，但 raw hash、word count 与 generation 保持正确。
- [ ] 容量 accumulator 流式计数，超过任何维度立即返回包含 `dimension/observed/allowed` 的 `MANUSCRIPT_CONTENT_TOO_LARGE`；ignored 文件仍验证身份、大小并计量。提供只读 observer/counter seam，分别记录目录枚举数、身份 probe 数、内容打开数与累计字节；每个边界测试都断言第一次 `observed > allowed` 后不再枚举下一项、不再打开任何内容，单文件大小可由身份/metadata 证明时不得先打开超限文件。
- [ ] `validateFull()` 验证索引闭包、唯一归属、章节资源对完整、卷/章节生命周期 UID 合并计数、journal candidate 所有权；外部新 UID/孤儿返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`。
- [ ] 为 80% 身份阈值产生持久诊断 warning，不因 tombstone 删除、ignored 文件删除或 revoke 释放容量。
- [ ] Task 3 只实现 fail-closed 的 Store/边界合同与内存 fixture：构造参数 `fileBoundary` 精确为 opaque **read capability**，与 `journalAuthority` 都在构造时固定；缺失、writer cap、plain clone、foreign/swap brand 均拒绝，绝不回退到按路径 `node:fs` 打开，也永不获得 create/write/relocate/delete。为保持 Task 3 可独立按 DAG 提交，本任务可在 `store.js` 暂留仅被内存 fixture 使用的 generic mint，任何 production composition 都不得引用；Task 6 必须在首次 production factory 出现的同一提交中把它迁到内部 registry + `server/testing/` test-only mint，并删除旧 export，此后 production/test brand 不再混用。候选只有在 authority 同时绑定 project、journal ID、target ref 与实际候选名时才升格，其他同形文件降为 residue 且不读、不哈希。真实 Windows no-delete-share、open-reparse、handle-bound read/identity boundary 后移 Task 6；Task 14B 只接线，不能注入 backend/callback/fake。
- [ ] `buildProjectionCandidate()` 只返回同一 validated snapshot 的文件事实、顺序、positions、raw hashes、Markdown availability、ignored member observations、capacity/warnings；不分配本机整数 ID，不决定 tombstone/proposal/route/generation。最小确定性 before/after closure 由 Task 7A 扩展同一个 `ManuscriptStore`，非创建结构命令完整表再由 Task 10B1 补齐，create 由 Task 10B3 编排；本任务不提前猜领域命令。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-paths.test.js server/tests/manuscript-format.test.js server/tests/manuscript-capacity.test.js server/tests/manuscript-store.test.js
git diff --check
git add server/manuscript/paths.js server/manuscript/format.js server/manuscript/capacity.js server/manuscript/store.js server/tests/manuscript-paths.test.js server/tests/manuscript-format.test.js server/tests/manuscript-capacity.test.js server/tests/manuscript-store.test.js server/tests/fixtures/manuscript-tree.js
git commit -m "feat: add canonical manuscript store"
```

---

## Task 4: 实现纯只读 ActiveManuscriptProjection

**Depends on:** Task 2。

**Files:**

- Create: `server/manuscript/active-projection.js`
- Create: `server/tests/active-manuscript-projection.test.js`

**Interfaces:**

```js
class ActiveManuscriptProjection {
  listVolumes(db, options) {}
  listChapters(db, options) {}
  getChapter(db, chapterId) {}
  resolveLegacyChapterNumber(db, volumeId, num) {}
  exportSnapshot(db) {}
}
```

- [ ] 本任务只实现同步、纯只读投影；每次调用只消费调用方已完成 schema 12 admission 与 freshness gate 后交付的精确只读 query facade `db`，不在实例上持有连接。不读取 route，不安装/检查 schema，不验证 digest/transition/freshness，也不执行任何写入。
- [ ] `listVolumes()` 只返回 `volumes.is_present=1`；`listChapters()`、`getChapter()` 与旧编号解析只返回 `chapters.is_present=1` 且父卷为空或 `volumes.is_present=1` 的行，并按 `chapter_position`/`manuscript_position` 提供稳定顺序。主身份是本机稳定 `chapter_id`；旧 `volume_id + num` 只解析活跃行，歧义显式拒绝。
- [ ] 未分卷章节在本任务只具备 list/get/metadata export；非结构 edit 编排归 Task 7B，move/reorder/delete 与 ignored-aware 结构语义归 Task 10B1，create 归 Task 10B3，产品 CRUD 接线归 Task 14B。
- [ ] 不暴露 `includeTombstones` 或调用方可切换的过滤选项；tombstone/恢复诊断后移为独立 capability，不能借 ActiveManuscriptProjection 绕过活跃过滤。
- [ ] `exportSnapshot()` 只返回冻结的 active metadata manifest（稳定 ID/UID、卷归属、sidecar 字段、word count、positions、raw hashes 与 content availability），不选择、读取、返回或拼接 `chapters.content`/正文 raw bytes。
- [ ] 产品读取接线以及 progress/overdue 语义统一后移到 Task 14B；本任务不修改 `recent-projects.js`、产品查询或兼容缓存。
- [ ] 运行并提交：

```powershell
bun test server/tests/active-manuscript-projection.test.js
git diff --check
git add server/manuscript/active-projection.js server/tests/active-manuscript-projection.test.js
git commit -m "feat: add active manuscript projection"
```

---

## Task 5: 实现同 generation 的 SQLiteProjectionStore

**Depends on:** Task 3 + Task 4。

**Files:**

- Create: `server/manuscript/projection-store.js`
- Create: `server/tests/manuscript-projection-store.test.js`

**Interfaces:**

```js
const PROJECTION_BASIS_DOMAIN = "mythpen.manuscript.projection-basis";
const PROJECTION_BASIS_VERSION = 1;
function canonicalProjectionBasisDigest(basis) {}
function canonicalIgnoredLedgerDigest(rows) {}

class SQLiteProjectionStore {
  buildTarget({
    candidate,
    currentProjection,
    targetGeneration,
    projectedAt,
    ignoredLedger,
    localIdentityPlan,
  }) {}
  validateTarget(target) {}
  publish({ projectStore, target, routeCas }) {}
}

module.exports = {
  SQLiteProjectionStore,
  canonicalProjectionBasisDigest,
  canonicalIgnoredLedgerDigest,
};
```

- [ ] Task 5 只实现纯的完整 target 编译器、纯 `validateTarget(target)` 与注入的 `projectStore.publishProjectionTarget({ target, routeCas })` 原子发布 port；使用只记录 preflight/transaction/CAS/commit disposition 的内存 fake 写聚焦测试，绝不 import、打开或伪造真实 NativeProjectStore/schema 12。代码/meta/observed schema trigger digest 不一致、schema too new、generation CAS 失败、transaction preflight 失败和 commit disposition unknown 在本任务都只是由 fake port 注入并验证原样传播，不能称为 schema 12 live admission 或真实 DML 证据。
- [ ] `projection-store.js` 唯一导出 `canonicalProjectionBasisDigest(basis)` 与 `canonicalIgnoredLedgerDigest(rows)`；Task 5 fake、Task 10A1 ledger 和 Task 12 真实 adapter 都必须 import/调用，禁止复制 canonicalizer、排序或摘要 material。basis 根对象 exact own keys 固定为 `domain, version, sourceKind, baseGeneration, volumes, chapters, sqliteSequence, ignoredBeforeDigest, pendingProposals, basisDigest`，其中 `domain = "mythpen.manuscript.projection-basis"`、`version = 1`、两个 digest 都只能是小写 64-hex SHA-256；basis 摘要 material 包含除 `basisDigest` 自身外的全部字段。卷/章按同表稳定整数 `id`、pending proposals 按稳定整数 `revisionId` 再按 `chapterId` 排序；ledger 行按 `resource_kind + resource_uid` 排序并覆盖其 exact schema 12 标量/JSON 字符串值。重复 key/ID、额外/缺失 key、错误 domain/version/sourceKind、非 plain data或非规范值全部拒绝；输入数组排列不影响摘要，任一 material 值变化必须改变对应摘要。
- [ ] `currentProjection` 是 exact、plain、deep-frozen 的 `{ projectUid, projectInstanceId, basis }` 快照；前两者是已 admission 项目的规范 UUID 绑定但不进入 basis digest。basis 是**紧凑依赖快照**而非第二份数据库：`sourceKind` 只能为 `schema11 | schema12 | empty`；schema11 volume exact `{ id, sortOrder }`、chapter exact `{ id, volumeId, num, bodyRawSha256, status }`；schema12 volume exact `{ id, uid, sortOrder, isPresent, deletedAt }`、chapter exact `{ id, uid, volumeId, num, isPresent, deletedAt, chapterPosition, manuscriptPosition, bodyRawSha256, status }`。schema11 source reader 对 `content` UTF-8 bytes 只计算一次 SHA-256 后立即丢弃正文，basis/journal 不保存旧正文；未列出的 `created_at/updated_at/data_version` 等本机列由 Task 12 在真实事务内原位保留，Task 5 不复制也不验证。`sqliteSequence` 只含规范化后的 `volumes`/`chapters` 两个 non-negative safe integer 值；`ignoredBeforeDigest` 只保存完整 before ledger 的 canonical digest（schema11/empty 使用规范空 ledger digest）；`pendingProposals` 只含 exact `{ revisionId, chapterId }` pending rows；`baseGeneration` 在 schema12 取 live generation，schema11/empty 固定为 `0`。`buildTarget()` 重算并比较 `basisDigest`；plain basis/identity 只供确定性编译，不能授权发布。
- [ ] target 只保存一份新正文：active rows 是来自 candidate 的完整文件派生投影字段与 ID/UID/num/最终 positions；当前 active→absent 及既有 tombstone→仍 absent 使用 compact tombstone/retain ref（卷：`id, uid, isPresent=0, deletedAt`；章再含 `num, chapterPosition=null, manuscriptPosition=null`），不复制旧 title/content/sidecar/local columns。Task 12 根据 ref 只更新 tombstone/presence/position 字段并原位保留其余旧列；复活/active 行则从同一 candidate 更新投影字段。target 仍冻结 exact `projectUid`/`projectInstanceId`、basis+digest、base/target generation、`projectedAt`、raw hashes、controlled-file facts、完整 ignored after ledger、同 generation 容量快照和派生 proposal invalidations。Task 5 focused 另断言总正文 UTF-8 bytes 只来自 active target 一次，basis/tombstone refs 中不存在 `content` 或其他旧大字段。
- [ ] `candidate` 必须把 `chapters.content`、availability、hash、word count、全部 sidecar 字段、positions、controlled-file facts 与容量快照绑定到同一个 Task 3 validated snapshot；`buildTarget()` 不重新读文件，也不接受调用方分别覆盖这些派生字段。输出只含可序列化 plain data，递归快照并冻结；相同输入逐字节 canonical 等价，便于 Task 6 持久冻结与恢复重放。
- [ ] `buildTarget()` 不接受 caller 传入 `proposalInvalidations`。它只从 compact basis 的 presence/body hash/status、candidate 的新 presence/body raw SHA-256/status 与 `pendingProposals` 派生 exact literal `pending → stale` 集：正文 bytes/hash 变化、章节删除或 sidecar `status` 变化才使该章节全部 pending revision stale；纯移动/重排以及其他 metadata 变化都不触发。schema11 old hash 已由 source reader 预计算进 basis；empty 不得有 pending rows。revision/chapter 不存在或映射不唯一时 fail-closed，输出按 `revisionId` 稳定排序并冻结。
- [ ] `projectedAt` 只接受可解析且重新序列化逐字节相同的 canonical UTC ISO 字符串 `YYYY-MM-DDTHH:mm:ss.sssZ`；本地时区、偏移、无毫秒、额外小数位、无效日期或等价但非规范拼写全部拒绝。它只用于本次 target 的 tombstone 时间，不能在重放时重新取时钟。
- [ ] `localIdentityPlan` 是按 `objectKind + uid` 排序的 exact discriminated assignment 数组；每项 exact keys 为 `{ assignmentKind, objectKind, uid, id }`，chapter 额外且必须有 `num`，只有需授权的分支额外且必须有 `reservationId`，volume 禁止 `num`。`assignmentKind` 仅允许：`reuse_uid`（schema12 已有 active/tombstone UID，逐项复用 basis 的稳定 ID/章节 `num`，禁止 `reservationId`）、`bind_legacy`（仅 schema11 migration，把 source row 的原 ID/章节 `num` 绑定到已预留规范 UID 与 `reservationId`）或 `reserved_new`（仅真正新行，携带已预留规范 UID、新整数 ID、章节 `num` 与 `reservationId`）。错 sourceKind、错 discriminator/exact keys、同一 `objectKind` 内重复 UID/整数 ID、缺 reservation、与同表 basis/对应 `sqliteSequence` 冲突或未覆盖全部新旧对象都在 `buildTarget()` fail-closed；卷与章节是独立 UID/整数 ID 命名空间，允许两表同时存在相同数值 ID。章节 `num` 只按 candidate 的最终 active 容器检查：已分卷按 `(volumeUid, num)` 唯一，未分卷按 `num` 唯一；跨卷同号与 tombstone 同号合法，tombstone 不占活跃编号。缺席对象产生带冻结 `projectedAt` 的 tombstone，同 UID 再现只走 `reuse_uid` 并复活；Task 5 不铸 reservation，也不把 plain plan 当授权，fake `projectStore` 在原子 preflight 内用私有测试 authority 重读 live basis/generation、调用唯一 digest helper，并逐项验证 `bind_legacy | reserved_new` reservation 后才允许 commit。
- [ ] `validateTarget(target)` 与 `publish()` 必须复用同一个 module-private target validator，禁止复制第二套 exact-key、basis、identity-plan 或 row-variant 检查。纯验证成功返回原 `target` 引用，不 clone、不调用任何 project-store port，也不产生文件或数据库副作用；Task 6 必须在首个文章文件副作用前调用它，并在恢复资产反序列化、递归冻结后再次调用，不能把无效 target 留到 `files_published` 后才发现。
- [ ] `publish()` 先调用同一个 `validateTarget()`，然后只把同一 target 引用与 `routeCas` 原样交给 `projectStore.publishProjectionTarget()`；不自行读取 live DB、分配 ID、解释 route、执行 SQL、clone target/token 或重试 commit-unknown。fake 在 basis/reservation/CAS 前先比较 target 的 `projectUid`/`projectInstanceId` 与该 fake store 的私有项目绑定，拒绝跨项目、跨实例或复制 target 重放。`routeCas` 缺失表示普通投影发布；存在时只能由同一 fake `projectStore` 的 module-private `WeakMap` brand 铸造并绑定同一事务意图。fake 同时拒绝 plain/clone/function/foreign-store route token、伪造/旧 basis、错误 generation 与无 authority 的新 ID，并证明合法 route CAS 与完整 target 同 commit、任一侧失败则整体不可见。
- [ ] Task 5 只证明 deterministic final target、ID/num 复用、tombstone、同 UID 复活、带已冻结 reservation 的新 ID，以及 fake port 的单事务 before/after/commit-unknown 语义；不声称执行真实两阶段 SQL、真实 `chapter_revisions` DML、真实物理 DELETE barrier、真实 trigger/data-version 行为或 schema 12 admission。这些 production 义务全部由 Task 12 的唯一真实 adapter 完成，Task 16 再做最终 DDL/投影矩阵。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-projection-store.test.js
git diff --check
git add server/manuscript/projection-store.js server/tests/manuscript-projection-store.test.js
git commit -m "feat: publish atomic manuscript projections"
```

---

## Task 6: 实现 FilePublicationJournal 与崩溃恢复

**Depends on:** Task 3 + Task 5。

**Files:**

- Create: `server/manuscript/file-publication-journal.js`
- Create: `server/manuscript/file-publisher.js`
- Create: `server/manuscript/capability-registry.js`
- Modify: `server/manuscript/store.js`
- Create: `server/platform/manuscript-file-boundary.js`
- Modify: `server/platform/durability.js`
- Modify: `server/platform/durability-win32.js`
- Modify: `server/control-store.js`
- Modify: `server/testing/fault-injection.js`
- Create: `server/testing/manuscript-capability-mint.js`
- Create: `server/tests/file-publication-journal.test.js`
- Create: `server/tests/file-publication-crash.test.js`
- Create: `server/tests/manuscript-file-boundary.test.js`
- Modify: `server/tests/manuscript-store.test.js`
- Modify: `server/tests/durability-primitives.test.js`
- Modify: `server/tests/control-store.test.js`
- Create: `server/tests/fixtures/file-publication-crash.js`
- Modify: `server/tests/fixtures/manuscript-tree.js`

**State model:**

```text
common: assets_reserved → target_reserved → prepared

full（ordinary 或 parent=draft_conflict）：
  assets_reserved | target_reserved + no article side effect + exact ownership → rolled_back
  prepared → files_published → projection_committed → completed
  before files_published + projection impossible + exact complete BEFORE → rolled_back

file_only（parent=migration | creation）：
  prepared → files_published
  before full pin: assets_reserved | target_reserved
    + durable parent child reservation/partial manifest/pin-absence/branded before → rolled_back
  after full pin（含 target_reserved）:
    + branded parentRecoveryIntent(before) → rolled_back

completed | rolled_back | parent-authorized files_published
  + terminal/pin/no-reference predicates → assets_collected
```

```js
// Task 6 用 fake；Task 12 提供唯一真实实现。
const projectionDisposition = {
  inspectTarget({ target, journalEvidence }) {}, // base | target | other
};

// 无参数、无 callback/backend/cap override；模块内一次 shared backend 铸一对 caps。
function createProductionManuscriptFileBoundary() {} // { readCapability, writerCapability }

class FilePublisher {
  constructor({ writerCapability }) {} // 只接受 canonical branded writer cap；不得接 plain methods/backend
  async createAsset(input) {}
  async readAsset(input) {}
  async inspect(input) {} // BEFORE | GAP | AFTER | OTHER
  async publish(input) {}
  async rollback(input) {}
  async collect(input) {}
}

// Task 6 用 fake；Task 12/13 分别提供 migration/creation 的真实实现。
const parentAuthority = {
  assertReservation({ authority, parent, childReservation }) {},
  assertPin({ authority, parent, manifest }) {},
  readRecoveryIntent({ authority, parent, assetManifest }) {}, // opaque before | after；partial 只可 before
  assertGc({ authority, parent, assetManifest, childState }) {},
};

class FilePublicationJournal {
  constructor({
    controlStore,
    filePublisher,
    projectionStore,
    projectStore,
    projectionDisposition,
    parentAuthority,
    projectBinding,
    assertWriteAuthority,
  }) {}
  async stageAssets({
    journalId,
    logicalRequestId,
    baseGeneration,
    targetGeneration,
    basisDigest,
    closure,
    identityReservation,
    parent,
    parentReservationAuthority,
  }) {} // { stagedAssets: opaque, stagedAfterFacts: frozen, reservationManifest: frozen }
  async bindTarget({ stagedAssets, projectionTarget }) {} // { preparedAssets: opaque, manifest: frozen }
  async prepare({ preparedAssets, parentPinAuthority }) {}
  async publishFiles(journalId) {}
  async commitProjection(journalId) {}
  async complete(journalId) {}
  async recover(journalId, { parentRecoveryIntent } = {}) {}
  async collectAssets(journalId, { parentGcAuthority } = {}) {}
  journalAuthority() {} // L2 v1 返回 Task 3 opaque deny-all resolveCandidate capability
}
```

- [ ] Task 6 只验证 frozen closure 的 exact 成员合同：branded controlled ref、父身份、before bytes/length/raw SHA-256/file identity、after bytes/length/raw SHA-256/存在性、无重复成员与固定顺序「正文 → sidecar → 卷/未分卷索引 → manuscript.json」。changed/new 的 after physical identity 只由后续 staged-after 实体提供。`controlledFiles` 是同 generation 的**全树事实**，closure 是最小变化集；最小 compiler/`ManuscriptStore.buildClosure()` 留给 Task 7A，非创建结构扩展留给 Task 10B1，create 扩展留给 Task 10B3，Task 6 不从 target 反推或扩大 closure。
- [ ] `projectBinding.recoveryRootIdentity` 精确绑定已存在的项目级 `<data>/control/manuscripts/<project_uid>/<project_instance_id>/file-assets/` 恢复资产容器；Journal 构造器还必须把真实 `controlStore.directory` 逐字节绑定到对应 `<project_instance_id>/` 根，并把 `controlStore.incarnationId` 绑定到 `projectBinding.controlIncarnationId`，错目录/错 incarnation 在任何读取或副作用前拒绝。Task 6 只 `OPEN_EXISTING`，不创建 recovery 或文章目录。ControlStore 根只为 exact `file-assets` 普通非 reparse 目录保留一个命名空间项，绝不解析其内部资产；近似名、同名文件、symlink/junction 和其他未知根项仍 fail-closed。全部 before/staged/target/displaced asset 直接使用该容器下扁平确定性 `<journal_id>.<asset_name>`，禁止 `<journal_id>/` 子目录；parser 必须从 binding、journal ID、ref 与 member index 重新派生并逐字节比较每个 final/recovery path，不能信任事件自报路径。受控 final path 统一复用 Task 3 `paths.js` authority，不复制第二套文件名拼接。Task 12/13 在任何 child reserve 前唯一创建并验证 ControlStore 根及这一长期容器；Task 7B/10B1/10B3 ordinary writer 只消费 activated 容器。GC 只删 manifest-owned 叶文件，永不删除 `file-assets` 或项目 ControlStore 根。
- [ ] caller 必须先给规范 UUIDv4 `journalId`、logical request binding 和创建命令的完整 serializable `identityReservation`（非创建为 null）。file_only 还须给由父 durable child-reservation event 铸造且绑定 exact closure/journal/request/generation 的 `parentReservationAuthority`，`stageAssets()` 在任何 child asset/event 前调用 `assertReservation()`。随后 compare-and-append `manuscript.file_publication.assets_reserved`，冻结 input digest、完整 identity assignment/reservation/source-basis、确定性 recovery paths、expected length/hash；之后只 create-new/fsync before copy 与 staged-after。displaced-before 绝不预建：只冻结 absent destination path、destination-parent identity、absence predicate 与 relocate 后应等于 frozen before 的 expected identity/hash；实际 first relocate 后才产生 displaced physical identity/两边 directory-fsync fact。recovery/article roots 必须同 physical volume。崩溃在 reserve/stage 间只允许同 request/assignment 按 exact expected 补齐；无法证明者只记 residual。输入 bytes 在首个 await 前独立复制。
- [ ] `stageAssets()` 返回 opaque capability、frozen `stagedAfterFacts` 和可从 child event chain 重建的 serializable partial `reservationManifest`；partial manifest 只列 expected facts 与事件已精确绑定的 owned identities，不能把未证明同名实体升级为 owned。每次 `createAssetVerified()` 成功后、交付 capability 前，journal 在当前 `assets_reserved | target_reserved` 状态 append/fsync 单调 ready fact，精确绑定 reservation digest、asset kind/path、actual identity、length/hash 与 file/parent flush；exact replay 幂等、冲突 enrichment 拒绝，create 与 ready fact 间强杀只留下 residual。changed/new 的 target controlled `fileIdentity` 必须来自将被 relocate 的同一 staged-after 实体，unchanged 沿用 Task 3 verified identity，delete 从 target facts 移除。`bindTarget()` 先调用 Task 5 唯一 `validateTarget()`，再 append `manuscript.file_publication.target_reserved` 冻结 target asset expected path/length/hash、ready before/staged identities 与 target binding，随后用同一 writer cap create-new/fsync 一份 exact target asset；其 ready fact 落盘后才返回 opaque `preparedAssets` 和完整 serializable manifest。before copy、staged-after、target asset 统一走 `createAssetVerified()`：内部 `node:fs` `O_CREAT | O_EXCL | O_RDWR`/`wx+` 同一 fd 写完、fsync、fstat、从同 fd 回读 length/hash/identity，fsync parent 后关闭，再由 `readVerified` 重开精确复核；未完整通过不交付 capability。恢复 rehydrate target 后递归冻结并重跑 validator，不重取时钟或补字段。
- [ ] `prepare()` 只消费同一进程 opaque `preparedAssets`；full 直接 prepare，file_only 还必须由 `parentAuthority.assertPin()` 验证 parent 已持久保存完整 manifest+canonical digest 及 exact child/parent/project/generation/closure/target/assets binding。只有 assets exact ready 后才 append `manuscript.file_publication.prepared`；它仍早于首个文章树副作用。规范事件统一使用 `manuscript.file_publication.` 前缀，suffix 仅为 `assets_reserved | target_reserved | prepared | files_published | projection_committed | completed | rolled_back | assets_collected`；前两个 suffix 各有恰好一个 `record_kind = reservation` 状态事件及零个或多个单调 `record_kind = asset_ready` identity/fsync fact，parser 拒绝跳态、重复冲突 payload、错 mode/parent/incarnation/binding、越序 ready fact 与未知状态。
- [ ] FilePublisher 构造器只接受 canonical branded `writerCapability`，由内部 registry gated resolver 在构造和每次读取/副作用前复核 mode/backend binding 后调用 exact 四个 writer methods；禁止传入、缓存或重新包装 plain operation object、backend、裸 handle、Store read cap 或 clone。它对 Journal 只暴露上面六个高层方法；`readAsset()` 与无副作用 `inspect()` 只能组合 writer cap 的窄 `readVerified`，不得猜现场或回退到 `node:fs`。该原语只接受 exact expected union：`absent + parentIdentity` 返回 `ABSENT`，或 `present + byteSize/identity/parentIdentity/sha256` 返回 `PRESENT` 与防御复制 bytes；OTHER 只能由 manifest 的全部已知 expected facts 均验证失败得出，不能读取或回显第三方 metadata。Journal 聚焦测试可以整体替换六方法 fake publisher，但 production FilePublisher 绝不把这种 fake 当 writer capability。正常路径不创建受控树 `.tmp`，也不用 overwrite/ReplaceFileW。before-present/after-present 只做两次 verified no-replace cross-directory relocate：重验 displaced destination absent 后 exact final before → destination，此时才得到 displaced=before identity并 fsync 两边父目录；同一 staged-after → absent final，再 fsync 两边父目录。create 只有第二步，delete 只有第一步。恢复只接受 `BEFORE(final=before, displaced absent, staged=after)`、`GAP(final absent, displaced=before, staged=after)`、`AFTER(final=after, displaced=before, staged absent)`；第三方抢占保留且拒绝覆盖，rollback 逆序 relocate 原实体。
- [ ] `manuscript-file-boundary.js` 的 production factory 必须零注入：不接收 backend、callback、cap override 或 fake，只建立一次 module-private shared backend，并以不同 brand/operation table 铸 Task 3 read cap（实现 Store 现有 exact 六方法，底层统一走 handle-bound `readVerified`）和 writer cap（exact `readVerified | createAssetVerified | relocateVerifiedToAbsent | deleteVerified`；首项只供 recovery asset/final 的 manifest-bound 冷读取）。Store 永不获得 writer 操作，FilePublicationJournal/FilePublisher 不能拿 Store read cap 冒充 writer。Task 3 旧的公开通用 file/journal capability mint 必须从 `store.js` 导出中删除：三种 canonical brand/records 只放在内部 `capability-registry.js`，production factory 与 Task 6 journal 只消费内部 mint，测试 fake 只从 `server/testing/manuscript-capability-mint.js` 的 test-only seam 创建。plain clone、foreign-backend cap pair、read/writer swap、旧 public mint 与 production test-mint injection 全部在副作用前拒绝；production pair validator 只验证 original frozen pair、production mode 和共同 backend token，不泄露 operation table。复用 `durability.js` 的 fsync/retry/error mapping，并在 `durability-win32.js` 只补共同缺少的 handle/rename/delete，不复制第二套 FFI/profile；每次使用前仍验证 cap/backend binding 与 exact ref/identity。
- [ ] full 只允许 `parent = null | draft_conflict`。`files_published` 之前默认前滚；只有 projection 不可能提交、前滚不可安全完成且逆序可证明完整 BEFORE 时才 append `rolled_back`，包括 prepared 后部分文件副作用。`files_published` 后绝不回滚，只用必填 `projectionDisposition.inspectTarget()` exact `base | target | other`：target 只补 `projection_committed`；base 重验 writer/project/journal authority 后最多 publish 一次并复查；other 或再次 unknown 为 `RECOVERY_REQUIRED`。generation、publish return 或 caller disposition 都不能自证。
- [ ] full 从 `prepared` 冷恢复时必须在任何 file relocate 前 rehydrate/validate target 并检查 projection；只有 exact `base` 可继续，`target | other | unknown` 均以零文章副作用进入 `RECOVERY_REQUIRED`。任何 `files_published` 分支在提交 projection 或推进 file-only parent 前都要重验 manifest 全成员完整 `AFTER`。任一底层错误携 `created | relocated | deleted = true` 时，高层必须保留该未决 disposition；缺少同一 pinned parent 的 flush receipt 时，重试不得仅凭路径外观升级为成功或写 terminal/GC 事件。
- [ ] file_only 只允许 `parent = migration | creation`，projection/projectStore/route 调用次数恒为 0。完整 pin 前，只有 durable parent child reservation、exact partial manifest、pin-absence 与父 safe-abort intent 可由 `readRecoveryIntent()` 铸 opaque `before`；正常父状态按同一 reservation 幂等继续 stage。完整 pin 一旦耐久，即使 child 仍是 `target_reserved`，恢复也只能消费绑定 exact parent/full manifest/pin/terminal 的 opaque `before | after`：before 才可逆序收敛并 `rolled_back`，after 才可前滚至 `files_published`。plain goal/clone/错 parent/绕过 pin 的 common rollback 全拒绝；child 不写 parent 状态，不提交 parent projection/route，不解除 reservation/pin。
- [ ] `collectAssets()` 必须避免最高 1 GiB assets 无界泄漏：full 只接受 `completed | rolled_back`；file_only 在完整 pin 前接受父 durable child reservation、safe abort、partial manifest、pin-absence 与 no-reference predicate，在完整 pin 后接受 parent 成功终态或 safe abort、匹配 child state、exact pin 与 no-reference predicate，统一由 `parentAuthority.assertGc()` 验证 authority。`deleteVerified` handle-bound 核对 partial/full manifest exact identity/link-count/size/hash，delete 后 fsync parent；只有已有与 exact path/identity 及同一 verified parent handle 绑定的 `deleted = true, parentFsync = true` 回执时，随后观察到 ABSENT 才可幂等。冷启动 ABSENT 无该回执必须保持 unresolved/`RECOVERY_REQUIRED`，第三状态同样保留且不写 `assets_collected`。全部 owned 叶文件清掉后才 append `...assets_collected`；`file-assets` 是长期项目容器，GC 不删除或替换它，`files_published` 单独不构成 GC 资格。
- [ ] Task 6 仍是 Task 3 `journalAuthority.resolveCandidate()` 的唯一 owner，但本轮没有任何 production producer 会在受控树创建 legacy `.tmp`，不得为不存在的正例预造事件 schema或靠手改事件自证。L2 v1 authority 因而固定 deny-all：所有 candidate shape 都保守降为 residue且不读、不哈希、不删。只有未来真实 importer/producer 与 exact manifest 事实一起进入明确任务时，才可实现正向 capability，并重新接受 D6 的完整 path/real-name/identity/open/terminal 评审。
- [ ] 8 组 focused RED 固定为：① intent-first reserve、serializable identity assignment 冻结、before/staged/target 的 O_EXCL 同 fd write/fsync/readback、caller buffer 隔离，且 stage 后 displaced path 仍 absent；② staged identity → controlled facts、target reserve/bind；③ file-only 父 reservation 缺失拒绝、staged 后 pin 前的 partial-manifest before/GC、pin 后 prepared 前与 prepared 后只能服从 branded before/after 三 crash window；④ update/create/delete 的 BEFORE/GAP/AFTER、displaced identity 只在 relocate 后出现、no-replace 抢占、locked/reparse/hard-link/cross-volume；⑤ full events 与 projection base/target/other/unknown；⑥ full rollback 和 file-only pre-pin/post-pin authority 分界；⑦ event parser、ControlStore directory/incarnation binding 与 deny-all candidate authority；⑧ zero-injection shared-backend factory 的 read/writer cap clone/foreign/swap/production-fake 负控，以及 terminal/ref/reservation/pin GC、handle-delete crash/idempotence/第三状态保留。强杀不按每个领域命令重复展开；epoch/feed/session join 留 Task 9A–9C/12/16。
- [ ] FilePublicationJournal 只向已建立并验证身份的 `mythpen/`、`volumes/`、`chapters/` 发布，不创建、删除或接管文章目录。Task 6 不实现 command→closure、reservation read/resume、真实 SQL/schema、parent journal、API/CLI/route/composition root/build-info；最小 closure/finalize 留给 Task 7A，ordinary request lookup/read/source 留给 Task 10B2，create resume 编排留给 Task 10B3；不运行全量 suite、production build、VM/13/19 或 candidate 验收。
- [ ] 运行并提交：

```powershell
bun test --test-name-pattern "manuscript verified (read|create|relocate|delete)" server/tests/durability-primitives.test.js
bun test --test-name-pattern "ControlStore reserves manuscript file-assets directory" server/tests/control-store.test.js
bun test server/tests/manuscript-store.test.js server/tests/manuscript-file-boundary.test.js server/tests/file-publication-journal.test.js server/tests/file-publication-crash.test.js
git diff --check
git add server/manuscript/file-publication-journal.js server/manuscript/file-publisher.js server/manuscript/capability-registry.js server/manuscript/store.js server/platform/manuscript-file-boundary.js server/platform/durability.js server/platform/durability-win32.js server/control-store.js server/testing/fault-injection.js server/testing/manuscript-capability-mint.js server/tests/manuscript-file-boundary.test.js server/tests/manuscript-store.test.js server/tests/file-publication-journal.test.js server/tests/file-publication-crash.test.js server/tests/durability-primitives.test.js server/tests/control-store.test.js server/tests/fixtures/file-publication-crash.js server/tests/fixtures/manuscript-tree.js
git commit -m "feat: add recoverable file publication journal"
```

---

## Task 7A: 建立最小文件闭包编译器与纯 UID reservation core

**Depends on:** Task 6。

**Files:**

- Modify: `server/manuscript/store.js`
- Create: `server/manuscript/uid-reservation.js`
- Modify: `server/tests/manuscript-store.test.js`
- Create: `server/tests/manuscript-uid-reservation.test.js`
- Modify: `server/tests/fixtures/manuscript-tree.js`

**Interfaces:**

```js
const buildResult = await manuscriptStore.buildClosure(validatedFileSnapshot, mutation);
const candidate = manuscriptStore.finalizeCandidate(buildResult, stagedAfterFacts);

class ManuscriptUidReservation {
  constructor({ uuidV4, reservationSources }) {}
  reserveNewIdentity({ kind, logicalRequestId, currentProjection, ignoredLedgerBefore, allocation, pathProbe }) {}
  assertReservation({ authority, identityReservation }) {}
}
```

- [ ] `buildClosure()` 只接受同一 `ManuscriptStore` 铸造、绑定同一项目的 branded validated snapshot；plain clone、foreign Store 或错 project 在任何 journal/recovery 副作用前拒绝。Task 7A 的 snapshot 尚无 generation/freshness authority，因此本任务不得伪称验证 generation；Task 9D 在 writer lease 与 Task 9C `ensureProjectionCurrent()` 后把文件快照、compact basis 和 generation 绑定到同一 write turn。mutation 本任务只覆盖 `chapter.replace_body`、`chapter.patch_sidecar`、`chapter.replace_body_and_sidecar` 与只改卷 `title/summary` 的 `volume.patch_metadata`；不实现 create/move/reorder/delete、ignored 引用移动/解除、migration full-snapshot 或 empty bootstrap。Task 12/13 仅在各自出现真实 consumer 时再扩展同一个 compiler。
- [ ] Store 从私有 parsed tree 推导逻辑 after 与最小 refs，只对 closure 中 `before.exists = true` 的成员用既有 handle-bound reader 重读 exact bytes，并逐项重验 parent/file identity、length 与 raw SHA-256；同 identity 原地改写也必须在返回 closure 前以 `EXTERNAL_CHANGE_CONFLICT` 阻断。不得为方便把全树 raw bytes 长期塞入 validated snapshot。
- [ ] branded `buildResult = { closure, candidateTemplate }` 递归冻结：unchanged 保留 Task 3 verified physical identity，changed/new 的 identity 显式为 null，deleted 从 candidate template 移除；before/after bytes、hash、size、parent/ref 与 publication order 均完整且不含 caller path。
- [ ] `finalizeCandidate()` 只接受同一 Store 的 branded buildResult；`stagedAfterFacts` 的 ref 集合必须与 changed/new after-present 集合完全相等，missing/extra/duplicate 或 ref/hash/size/parent 任一不符都拒绝。成功时注入 staged physical identity、同步 body/sidecar identity，并返回可直接交给 Task 5 `buildTarget()` 的 exact recursive-frozen candidate；service 不得自行宽松 merge。
- [ ] `ManuscriptUidReservation` 在本任务只是共享分配 core：构造器固定注入 `uuidV4` 与 `reservationSources`，没有 default-empty catalog；每次 reserve 接收完整 schema-12 `currentProjection`、`ignoredLedgerBefore`、exact `pathProbe` port，以及 `allocation = { containerVolumeUid, requestedNum }`（卷两项均为 null）。它先调用 Task 5 唯一 `canonicalProjectionBasisDigest()`/`canonicalIgnoredLedgerDigest()` 重算并逐项绑定 compact basis 与完整 ledger，再做 identity capacity；任一失败时 source/CSPRNG/path 调用数都为 0。随后必须先取得 scope 回显精确且 `complete = true` 的全部 reservation source 快照，才进入固定实现常量限制的有界循环：生成规范 UUIDv4，检查 active+tombstone、ignored、当前 project UID、同项目同 kind 全部仍存在且未 GC 的 reservation（包括 nonterminal/activated/aborted），最后检查规范路径/alias absence。source 不完整直接 `RECOVERY_REQUIRED`；确定碰撞只在本轮循环重抽，耗尽以 `UID_RESERVATION_COLLISION` 终止。新 ID 精确为对应 `sqlite_sequence + 1`，章节 num 取显式 requestedNum 或目标 active 容器 max+1，tombstone 不占号且不同卷可同号。
- [ ] 成功返回 `{ identityReservation, authority }`：前者是 serializable recursive-frozen manifest，后者是同进程 opaque capability。`assertReservation()` 必须同时校验原 authority 引用和 exact manifest；plain/clone/foreign authority、manifest clone 或任一 binding 漂移均拒绝。Task 10B3 首次 ordinary create 在 `stageAssets()` 前必须调用这一方法，恢复则改用 Task 10B2 FilePublicationJournal 耐久 resume authority；两类 authority 不得互换。Task 7A 只定义必填 port contract并用 fake 测试，不声称已有 production adapter：ordinary journal lookup/read/source 后移 Task 10B2，create 编排后移 Task 10B3，registry/existing-root/MigrationJournal source 与 Store name-index path adapter后移 Task 12，ProjectCreationJournal source 后移 Task 13，完整 production catalog/CSPRNG composition 后移 Task 14B。不承诺 `assets_reserved` 前跨进程 logical-request 幂等，也不铸 `bind_legacy`。
- [ ] 聚焦测试覆盖四类 closure、no-op、exact before 重读、snapshot/buildResult brand、strict finalize merge、unsupported Markdown 在 stage 前拒绝，以及 UID core 的非法随机值、active/tombstone/ignored/catalog/path/casefold 碰撞与不完整 source 零副作用；不运行 Task 6 journal suite、全量 suite 或 VM。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-store.test.js server/tests/manuscript-uid-reservation.test.js
git diff --check
git add server/manuscript/store.js server/manuscript/uid-reservation.js server/tests/manuscript-store.test.js server/tests/manuscript-uid-reservation.test.js server/tests/fixtures/manuscript-tree.js
git commit -m "feat: compile deterministic manuscript closures"
```

---

## Task 7B: 编排 ordinary/full 非创建写入

**Depends on:** Task 7A。

**Files:**

- Create: `server/manuscript/l2-service.js`
- Create: `server/tests/manuscript-service-l2.test.js`

**Interface:**

```js
function createL2ManuscriptService({ manuscriptStore, fileJournal, projectionStore }) {
  return {
    execute(command, turnContext) {},
  };
}
```

- [ ] 只接受 ordinary/full、非创建的 `chapter.replace_body`、`chapter.patch_sidecar`、`chapter.replace_body_and_sidecar` 与只改 `title/summary` 的 `volume.patch_metadata`；相同 canonical after 是 no-op，必须在 `stageAssets()` 前返回且 journal 调用数为 0。move/reorder/delete 与 ignored-aware 结构序列化后移 Task 10B1，ordinary reservation lookup/read/source 后移 Task 10B2，create 编排后移 Task 10B3；file_only parent 编排留给 Task 12/13。
- [ ] `turnContext` exact keys 只含 `journalId, logicalRequestId, projectedAt, currentProjection, fileSnapshot, ignoredLedger`。首个 await 前完成 exact-key/clone/accessor 检查和独立快照；`fileSnapshot` 必须来自同一 Store，ordinary 只接受 `sourceKind = schema12`，ignored digest 必须匹配。base generation 只从 `currentProjection.basis.baseGeneration` 取得，target generation 固定为 base+1；active projection 与 draft conflict decision 不进入本阶段，Task 11A/14B 有真实 consumer 时再扩展。
- [ ] 固定且可观察的顺序为 `buildClosure（恰好一次）→ stageAssets(identityReservation = null, parent = null) → finalizeCandidate(stagedAfterFacts) → buildTarget → bindTarget → prepare → publishFiles → commitProjection → complete`。`commitProjection()` 已经经 journal 调用 projection publish，service 不得二次发布；任一步失败只停止并保留 journal 给后续 admission recovery，不自行猜测回滚或伪造 parent authority。
- [ ] local identity plan 只能从完整 schema-12 basis 生成包含 tombstone 的稳定排序 `reuse_uid`；本任务没有 `reserved_new`/`bind_legacy`，不取得 lifecycle/writer lease，不调用 REST、现有 `server/manuscript-service.js`、Zustand 或 feed。产品入口切换统一留到 Task 14B。
- [ ] fake store/journal/projection 测试逐项断言四类 closure、no-op、call order、恰好一次 build、失败停止和输入快照；只跑本文件，不重跑 Task 6 journal suite、全量 suite 或 VM。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-service-l2.test.js
git diff --check
git add server/manuscript/l2-service.js server/tests/manuscript-service-l2.test.js
git commit -m "feat: orchestrate ordinary L2 manuscript writes"
```

---

## Task 8A: 实现 Windows existing-file lifecycle lease adapter

**Depends on:** Task 6。

**Files:**

- Create: `server/platform/windows-manuscript-lifecycle-lease.js`
- Create: `server/tests/windows-manuscript-lifecycle-lease.test.js`
- Create: `server/tests/fixtures/manuscript-lifecycle-worker.js`
- Modify: `server/platform/durability.js`
- Modify: `server/platform/durability-win32.js`
- Modify: `server/tests/durability-primitives.test.js`

**Interfaces:**

```js
// durability.js / durability-win32.js；只打开已存在的普通文件并锁定固定 `[0,1)`。
function acquireExistingFileRangeLease(filePath, { expectedIdentity, exclusive }) {}

const lifecyclePlatformIdentity = Object.freeze({
  canonicalRealControlDirectory: '<absolute canonical real path>',
  controlDirectoryIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
  controlParentDirectoryIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
  lifecycleLockIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
});

function createWindowsManuscriptLifecycleLeaseAdapter() {
  return {
    acquireShared(lifecyclePlatformIdentity) {},
    acquireExclusive(lifecyclePlatformIdentity) {},
  };
}

// acquire* 只返回 module-branded frozen opaque lease，公开面精确为 state + release。
lease.state; // 'HELD' | 'RELEASED' | 'RELEASE_DISPOSITION_UNKNOWN'
lease.release(); // frozen { disposition: 'UNLOCKED_AND_CLOSED' | 'CLOSED_AFTER_UNLOCK_FAILURE' }
```

- [ ] 在既有 `durability.js` / `durability-win32.js` 框架中只增加窄的 existing-file range-lock primitive：`GENERIC_READ | GENERIC_WRITE`、`FILE_SHARE_READ | FILE_SHARE_WRITE`、不共享 delete、`OPEN_EXISTING`、固定 `[0,1)` 且 `LOCKFILE_FAIL_IMMEDIATELY`；不向调用者开放 creation disposition、share flags、任意 range、create/rename/delete 或未经验证的路径能力。
- [ ] `LockFileEx` / `UnlockFileEx` 及其 OVERLAPPED 支持必须在首次调用该新 primitive 时单独 lazy load；缺符号、加载失败或能力自检失败只使 manuscript lifecycle primitive fail-closed，不得让既有 L1 backend 构造、耐久能力检测、activation 或任一旧 primitive 失败。
- [ ] `lifecyclePlatformIdentity` 是 deep-frozen exact-key object：只有 `canonicalRealControlDirectory | controlDirectoryIdentity | controlParentDirectoryIdentity | lifecycleLockIdentity`；三个物理身份又都只有 canonical decimal-string `dev | ino`，拒绝缺项、额外键、非绝对/非 canonical-real 路径、数字型身份或未 deep-freeze input。adapter 不接受 caller path，只从该 directory 派生规范 sibling `.manuscript-<sha256(canonical-real-control-directory)>.lifecycle.lock`；真实路径与允许别名必须以 `controlDirectoryIdentity` 汇聚到同一物理锁。
- [ ] 锁路径打开前以 `lstat` 拒绝 reparse，`CreateFileW` 必须同时带 `OPEN_EXISTING | FILE_FLAG_OPEN_REPARSE_POINT` 以打开 reparse 本体而不跟随；打开后再以 handle-bound facts 确认锁是已存在的普通空文件（非 directory/device、非 reparse、`byteSize = 0`、`nlink = 1`），且 exact `lifecycleLockIdentity`、ControlStore directory 与父目录身份都未变。任一 pre/post 事实不一致都在 `LockFileEx` 前 fail-closed，不得锁定被跟随的 target。
- [ ] existing-file primitive 只返回 module-branded frozen opaque lease，不泄漏 handle/path/OVERLAPPED/identity。初始 `state = HELD`；`release()` 严格执行 `UnlockFileEx → CloseHandle`，两者成功返回 frozen `UNLOCKED_AND_CLOSED`，unlock 失败但 close 已知成功返回 frozen `CLOSED_AFTER_UNLOCK_FAILURE`，两者才可转 `RELEASED`。close 失败/不明则转为粘性 `RELEASE_DISPOSITION_UNKNOWN`、抛错并要求 controller fence；只有 `HELD` 可首次调用 release，已释放/不明后的再调用都 fail-closed。
- [ ] adapter 永不创建或补建锁文件；只有 Task 12 MigrationJournal 与 Task 13 ProjectCreationJournal 父协议可创建它。Task 8A 测试 fixture 可以在隔离临时根中显式预建 exact 空锁文件，但该搭架不是 production creation owner。
- [ ] focused 两进程测试 shared/shared 成功，shared/exclusive、exclusive/shared、exclusive/exclusive 稳定映射 `PROJECT_WRITE_BUSY`；强杀 owner 后可重新取得。exact-key/freeze、空普通文件、reparse target/self、hard-link、身份变化、Unlock/Close/符号缺失与两种已知 release result/disposition unknown 均有 focused 负控；只有 close 已知成功才证明释放，其余 fenced 或 `MANUSCRIPT_LIFECYCLE_UNAVAILABLE`。
- [ ] Task 8A 只交付 candidate adapter 与 local/focused 证据，不修改 build-info、L1 production activation controller 或 production build，不设置、广告或声称 `manuscriptLifecycleLease = true`。最终 compiled capability 声明与验收只能在 Task 17B 最终 source 冻结后执行。
- [ ] 运行并提交：

```powershell
bun test --test-name-pattern "existing-file range lease" server/tests/durability-primitives.test.js
bun test --timeout 30000 server/tests/windows-manuscript-lifecycle-lease.test.js
git diff --check
git add server/platform/windows-manuscript-lifecycle-lease.js server/platform/durability.js server/platform/durability-win32.js server/tests/windows-manuscript-lifecycle-lease.test.js server/tests/durability-primitives.test.js server/tests/fixtures/manuscript-lifecycle-worker.js
git commit -m "feat: add Windows manuscript lifecycle leases"
```

---

## Task 8B: 实现 session admission 状态机

**Depends on:** Task 6。

**Files:**

- Create: `server/manuscript/session-controller.js`
- Create: `server/tests/manuscript-session-controller.test.js`

**Interfaces:**

```js
class ManuscriptSessionController {
  constructor({ lifecycleLeaseAdapter, registryAdmission, routeAdmissionVerifier }) {}
  async openSession(projectSelector) {}
  async admit(session, operation) {}
  async close(session) {}
}

// Task 8B 只消费该必填 port；Task 14B 才注入真实 registry/config owner。
registryAdmission.withProjectIdentity(projectSelector, async (exactFrozenIdentity) => {});
```

- [ ] 三个依赖都必填且在任何 lease/路由/操作前精确验证；Task 8B 只用可观察 fake ports，不导入未来的 RouteStore、config DB 或产品 composition。`projectSelector` 只允许已注册项目名与 expected project-instance ID，不接受 path、ControlStore directory、lock filename 或 caller-built identity。
- [ ] `openSession(projectSelector)` 固定顺序为 `registry/config lease enter → withProjectIdentity 产生 exact frozen identity → shared acquire/reuse → verifyAfterLease(identity) → 登记 session/refcount → registry/config lease exit → 返回 opaque session`。`registryAdmission` 必须在 callback 全期持有 config lifecycle lease；verifier 重读 route、project UID/instance、数据库/文章根物理身份、generation 和“存在则成功终态”的父 journal。
- [ ] session 是 module-branded opaque authority；plain/clone/foreign/closed/closing session 均在 operation 前拒绝。同进程同物理项目的底层 shared handle 按已打开 session 数 ref-count 复用，不按 caller 字符串、路径别名或单次 operation 重复建锁。
- [ ] shared-entry 的唯一 key 精确为 `controlDirectoryIdentity.dev + ':' + controlDirectoryIdentity.ino`，不用 project selector、UID、path 或 canonical string。controller 在首个 `await` 前、同一单写者临界区先安装带 reserved waiter/ref 的 `pending` entry；同 key 的并发 first-open 只能 join 该 promise，因而底层 shared acquire/handle 恰好一个，每个 caller 仍分别执行 exact `verifyAfterLease()` 后才把 reservation 转为 session ref。acquire 失败必须以原始 code/cause 拒绝全部 joiner 并原子删除无 handle entry；单个 verifier 失败只回滚其 reserved ref，最后一个 reservation/session 都失败才释放新 handle 并删除 entry。回滚释放 disposition unknown 时保留粘性 fenced entry/controller，禁止删 entry 后重开第二个 handle。
- [ ] `admit(session, operation)` 只对已验证的 open session 在 operation 前增加该 session 的 `inFlight`，并在成功、失败或取消后于 `finally` 减回；所有普通读取、写入、自动保存、导出和 AI 上下文最终都必须经过这一边界。
- [ ] `close(session)` 先原子禁止该 session 的新 admission，只等待该 session 自身 `inFlight = 0`，再减少项目 session refcount；只有最后一个 session 关闭才按 `UnlockFileEx → CloseHandle` 释放底层 shared handle。verifier 拒绝时 operation 调用数为 0，本次新取得/增加的 ref 按已知 disposition 回滚，原始 code/cause 原样传播；release disposition unknown 必须 fence controller。
- [ ] focused 顺序测试精确观察 `config enter → identity → shared → verify → config exit → opaque session → admit/operation → close`，并覆盖并发 open、共享 handle 复用、单 session close 不影响其他 session、close 等待自身 in-flight 以及全部失败路径。禁止 shared→exclusive 原地升级；`beginRetiring()`、项目级 `drain()` 和 opaque retirement epoch 整体留给 Task 14。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-session-controller.test.js
git diff --check
git add server/manuscript/session-controller.js server/tests/manuscript-session-controller.test.js
git commit -m "feat: gate manuscript sessions"
```

---

## Task 9A: 实现 Windows direct-feed platform adapter

**Depends on:** Task 6。与 Task 9B 可并行；本任务不导入 session、projection、journal 或产品路由。

**Files:**

- Create: `server/platform/windows-manuscript-change-feed.js`
- Create: `server/tests/windows-manuscript-change-feed.test.js`
- Create: `server/tests/fixtures/manuscript-feed-worker.js`

**Interfaces:**

```js
const changeFeedPlatformIdentity = Object.freeze({
  canonicalRealMythpenDirectory: '<absolute canonical real path>',
  articleRootDirectoryIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
  mythpenDirectoryIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
  volumesDirectoryIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
  chaptersDirectoryIdentity: Object.freeze({ dev: '<decimal string>', ino: '<decimal string>' }),
});

function createWindowsManuscriptChangeFeedAdapter() {
  return {
    assertIdentity(changeFeedPlatformIdentity) {}, // pure; returns the same validated reference
    tryOpen(changeFeedPlatformIdentity) {},
    // module-branded frozen exact result:
    // { outcome: 'OPENED', owner }
    // | { outcome: 'NO_SLOT' }
    // | { outcome: 'UNAVAILABLE', error, closeDisposition: 'KNOWN_CLOSED' | 'UNKNOWN' }
  };
}

// OPENED owner 是 opaque module authority；公开面精确为：
owner.state; // 'ARMED' | 'STOPPING' | 'CLOSED' | 'CLOSE_DISPOSITION_UNKNOWN'
owner.feedInstance(feedId); // opaque handle-instance authority
owner.probeEvents(); // frozen exact { mythpen: boolean, volumes: boolean, chapters: boolean }
owner.takeCompletion(feedId); // null | branded frozen { feedId, handleInstance }
owner.rearm(completion);
owner.decode(completion); // frozen exact { outcome: 'RECORDS', records: [{ action, component }] }
                          // | { outcome: 'COVERAGE_LOST', reason }
owner.retireCompletion(completion);
owner.beginStopping();
owner.cancelPending(feedId); // null | terminal branded completion
owner.close(); // frozen { disposition: 'CLOSED' }
```

- [ ] `changeFeedPlatformIdentity` 只接受上面五个 exact own data keys，顶层和四个 `{ dev, ino }` 都 deep-frozen；路径必须是绝对 canonical real `mythpen/`，身份只接受 canonical decimal strings。`assertIdentity()` 是无副作用的唯一 pure validator，成功只返回同一原引用；9C capability=false 时也必须先调用它，不能复制 shape validator。adapter 只从该路径内部派生 `volumes/chapters`，不得接受 caller path、文件名、share flags、buffer size、feed count 或目录映射。打开前后用现有 verified inspection 固定 path/parent；更重要的是，对三个实际 watched handles 分别调用 `GetFileInformationByHandle`，直接核对 DIRECTORY、非 reparse 与 expected `dev:ino`。任一 alias、reparse、父/目录 identity race 或 handle-bound mismatch 都返回 fail-closed `UNAVAILABLE`，不能以二次 path inspection 代替 handle 事实。
- [ ] module 单独 lazy-load/cached 且冻结 Win32 x64 ABI：`CreateFileW(ptr,u32,u32,ptr,u32,u32,ptr)->u64`、`CreateEventW(ptr,i32,i32,ptr)->u64`、`ResetEvent(u64)->i32`、`ReadDirectoryChangesW(u64,ptr,u32,i32,u32,ptr,ptr,ptr)->i32`、`WaitForSingleObject(u64,u32)->u32`、`GetOverlappedResult(u64,ptr,ptr,i32)->i32`、`CancelIoEx(u64,ptr)->i32`、`GetFileInformationByHandle(u64,ptr)->i32`、`CloseHandle(u64)->i32`、`GetLastError()->u32`。每请求使用 zero-filled 32-byte x64 `OVERLAPPED`（event handle 在 offset 24）和独立 4-byte transferred count；不注册 FFI/native callback。缺符号、错误 return width、非法 handle/result 或调用抛错只使本 adapter `UNAVAILABLE`，不得进入 L1 eager loader、影响 L1 backend 或 Task 8A adapter。
- [ ] 三个非递归目录各用 `FILE_LIST_DIRECTORY`、`OPEN_EXISTING`、`FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_OVERLAPPED`，只共享 read/write、不共享 delete；每 feed 独立 manual-reset event 与两块 DWORD-aligned 1 MiB user buffer。Windows 在该 handle 的首次 `ReadDirectoryChangesW(..., nBufferLength=1 MiB, subtree=0, filter=0x5f, bytesReturned=0, callback=0)` 建立对应内部 allocation；JS 不再另分配所谓第三块“kernel buffer”。parser 只接受 `FILE_NOTIFY_INFORMATION` 的 `u32 next/action/nameByteLength + UTF-16LE name`，逐项验证非空、偶数字节、4-byte next alignment、边界、终止记录、无 NUL/分隔符/孤立 surrogate 的单组件；Task 3 才负责规范 shape/classification。零字节、`ERROR_NOTIFY_ENUM_DIR`、malformed/unknown action 都返回 coverage loss，绝不静默丢弃。
- [ ] `feedInstance()` 只返回 owner-bound opaque handle-instance authority。`probeEvents()` 返回上面的 exact frozen 三 boolean；`takeCompletion()` 与 `cancelPending(feedId)` 只返回 `null` 或 exact branded `{ feedId, handleInstance }` completion；`decode()` 只返回 branded frozen `RECORDS`（每项 exact `{ action, component }`，action 仅 `ADDED | REMOVED | MODIFIED | RENAMED_OLD_NAME | RENAMED_NEW_NAME`）或 `COVERAGE_LOST`（固定 reason enum）。raw handle、OVERLAPPED、buffer、path 与 mutable bytes永不出模块；owner/completion/instance plain clone、foreign owner、错 feed、重复 rearm-decode-retire 全拒绝。全部探测 caller-driven；不建立 background pump、timer、callback 或 polling loop。
- [ ] `MAX_ARMED_FILE_PROJECTS_PER_PROCESS = 1` 是 module-global 固定槽，key 为 `mythpenDirectoryIdentity.dev + ':' + ino`。`tryOpen()` 只有完整打开并 armed 三 feed 才返回 `OPENED`；只有另一个已知 live/正在 stopping owner 占槽才返回 `NO_SLOT`，不排队、不 LRU/抢占。partial-open cleanup 或既有 owner close unknown 必须返回 `UNAVAILABLE + closeDisposition:'UNKNOWN'`，其 error 带 own immutable `releaseDispositionUnknown = true`，并保留 sticky slot；9C 必须 fence，不能把它当 NO_SLOT 降级。只有 owner `close()` 已知成功才释放槽。
- [ ] `beginStopping()` 后禁止 rearm。`cancelPending(feedId)` 逐 feed 发 `CancelIoEx`，并等待 `GetOverlappedResult` 进入 normal、`ERROR_OPERATION_ABORTED` 或已知失败终态；CancelIoEx true、`ERROR_NOT_FOUND` 或 event signaled 本身都不是终态。terminal completion 仍须上层 observe/account 后 `retireCompletion()`；此前 buffer 不可复用，`close()` 必须拒绝。全部 terminal completion 已由上层 account 并在 platform 侧 retired 后，close 顺序固定为每 feed directory handle → event handle → 清 user-buffer refs，再返回 frozen `CLOSED`；platform 只验证自己的 terminal/retired authority，不冒充 9B state。任一 `CloseHandle` 抛错/0/非法返回把 state 粘为 `CLOSE_DISPOSITION_UNKNOWN`，不重试、不报 closed、不释放 slot/shared。
- [ ] focused RED→GREEN 覆盖 exact identity/API/ABI、三 feed 隔离、buffer parser、overflow/loss、completion brand、rearm gap、partial-open cleanup、module slot、cancel-before/after-complete、`ERROR_NOT_FOUND`、终态前拒绝 free/close、每个 handle close 故障与两进程真实事件；不跑 full/build/VM。Task 9A 只交付 candidate，不修改 build-info，也不设置或广告 production `manuscriptChangeNotification = true`。
- [ ] 运行并提交：

```powershell
bun test --timeout 60000 server/tests/windows-manuscript-change-feed.test.js
git diff --check
git add server/platform/windows-manuscript-change-feed.js server/tests/windows-manuscript-change-feed.test.js server/tests/fixtures/manuscript-feed-worker.js
git commit -m "feat: add Windows manuscript direct feed"
```

---

## Task 9B: 实现线性化 feed-state

**Depends on:** Task 6。与 Task 9A 可并行；本任务是纯内存状态机，不导入 Win32、Store、projection、session 或产品代码。

**Files:**

- Create: `server/manuscript/feed-state.js`
- Create: `server/tests/manuscript-feed-state.test.js`

**Interfaces:**

```js
class ManuscriptFeedState {
  arm(feedId, handleInstance) {}
  enterDegraded(reason) {}
  gateSnapshot(probeEvents) {}
  observeCompletion(feedId, handleInstance) {} // opaque completion authority
  recordRearm(completion, handleInstance) {} // 只在 platform rearm 已成功后调用
  accountCompletion(completion, dirtyPaths, coverageLost) {}
  claimRefresh(baseGeneration) {} // opaque refresh authority
  claimSnapshot(claim) {} // exact frozen { baseGeneration, dirtyPaths }
  settleRefresh(claim, result) {} // exact frozen plain refresh-result union
  beginStopping() {}
  closeFeed(feedId, handleInstance) {}
  finishClosed() {}
}

// dirtyPathKey 只能是下面三个 canonical relative prefix + 一个已验证单组件：
// mythpen/<component> | mythpen/volumes/<component> | mythpen/chapters/<component>
// result 是按 disposition 区分的 exact frozen plain union：
// { disposition:'COMMITTED', baseGeneration, targetGeneration, refreshKind }
// { disposition:'ALREADY_CURRENT', generation, refreshKind }
// { disposition:'KNOWN_NOT_COMMITTED'|'UNKNOWN', generation, refreshKind, error }
// generation 均为 non-negative safe integer；refreshKind: 'FULL' | 'INCREMENTAL'
```

- [ ] 所有 mutation、`probeEvents()` 调用与 snapshot 组装只经过同一 mutex/单写者执行器；`gateSnapshot(probeEvents)` 在同一不可 `await` 的临界区恰好调用一次同步 probe，并原子返回三个 event、每 feed handle instance/armed/observed/accounted、普通 dirty、refresh claim/base generation、coverage-loss epoch 与 lifecycle state。observed/accounted/coverage-loss epoch 全部是进程内不回绕的 non-negative `BigInt`，诊断边界只输出 canonical decimal string，禁止转 `Number`；probe 抛错先锁存 loss，禁止调用方拼接 clean。
- [ ] `observeCompletion()` 必须先把同 instance feed 置 unarmed、递增 observed 并铸 module-branded opaque completion；同 feed 最多一个未 accounted authority。platform rearm 成功后才允许同 authority `recordRearm(completion, handleInstance)`；rearm 失败不得传 caller boolean，而是保持 unarmed 并直接以 coverage-loss evidence `accountCompletion()`。`dirtyPaths` 只接受 dense frozen unique canonical relative keys，不接受绝对路径、`.`/`..`、反斜杠、额外层级或 caller object；Task 3 后续才解释组件 shape。最后一次 account 原子合并 dirty/loss并递增 accounted；跳步、倒序、重复、plain/clone/foreign/stale instance 均拒绝且不能修改计数。
- [ ] handle instance 只能在旧实例 stopping/closed 且 coverage loss 已锁存后更换；旧 completion、probe 或 refresh claim 不能影响新实例，counter reset 不能消除旧差值。确定性 ABA、background-taken-before-parse、rearm failure、decode throw 与 account throw 测试都不能产生 false-clean。
- [ ] fresh state 从 startup loss/full-dirty 开始；仅把三 feed `arm()` 成功不能产生 clean。只有同一稳定 handle/count/loss witness 下确定完成的 FULL refresh 才能清 startup loss；degraded state 则永不清除该 loss。
- [ ] `claimRefresh()` 在一个提交中冻结 base generation、把当时 dirty 移入 immutable refreshing set 并铸 opaque claim；新事件只进普通 dirty。`settleRefresh()` 逐 variant 精确校验上面 frozen plain union 的外层 own data descriptors，禁止 truthy/额外键/accessor/错误 generation；failure variant 的原始 `error` 引用不 clone、不 freeze、不执行属性：`COMMITTED | ALREADY_CURRENT` 可按 generation 结清 claim，`KNOWN_NOT_COMMITTED` 合回 dirty并由上层原样传播 `error`，`UNKNOWN` 保留/合回并锁存 loss后传播同一 `error`。只有 `refreshKind='FULL'` 且结果已确定、三个 feed armed、observed=accounted、handle instances 与 coverage-loss epoch 未变时才可清 loss；INCREMENTAL 永不清 loss。9B 不解释 self-event 或 journal 语义，也不要求外部 port 铸造本模块私有 brand。
- [ ] `enterDegraded(reason)` 只接受 `CAPABILITY_DISABLED | NO_SLOT | KNOWN_UNAVAILABLE`，并在零 handle 状态一次性把三 feed 标成 absent/closed、锁存 startup loss/full-dirty；该 owner 仍可 `claimRefresh()`/`settleRefresh(FULL)`，但任何 FULL 都不能清除 degraded loss，也永远不能被 event gate 判 clean。`claimSnapshot(claim)` 是 Task 9C full refresh 外部 port 唯一可消费的数据面，只返回 exact recursively frozen `{ baseGeneration, dirtyPaths }`；它不泄露/复制 claim authority，plain/clone/foreign/stale claim 都拒绝。`beginStopping()` 后 degraded owner 可在无 `closeFeed()` 调用时直接 `finishClosed()`。
- [ ] `beginStopping()` 原子阻止新 state gate/claim/arm；已观察 completion 仍须按同一 authority 结清。9C 只在 platform terminal completion 已 account 且 retired 后调用 `closeFeed(feedId, handleInstance)`；9B 自身只验证同 instance 的 state 已 accounted/stopping，不伪造 platform terminal proof。`finishClosed()` 只证明三 feed state closed（或已显式进入 zero-handle degraded）且无 completion/claim，不声称验证 9C freshness admission/gate 计数。stop/close 永不把 dirty/loss 改写成 clean。
- [ ] focused RED→GREEN 只覆盖上述纯状态交错、opaque authority、loss/ABA/stop/close；不跑 platform test、full/build/VM，不修改 capability/build-info。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-feed-state.test.js
git diff --check
git add server/manuscript/feed-state.js server/tests/manuscript-feed-state.test.js
git commit -m "feat: linearize manuscript feed state"
```

---

## Task 9C: 实现 freshness 与 session-owned feed 生命周期

**Depends on:** Task 3 + Task 4 + Task 5 + Task 6 + Task 8A + Task 8B + Task 9A + Task 9B。Task 9A/9B 都完成后才开始；本任务只用必填可观察 fake ports，不建立真实产品 composition。

**Files:**

- Create: `server/manuscript/freshness.js`
- Create: `server/tests/manuscript-freshness.test.js`
- Modify: `server/manuscript/session-controller.js`
- Modify: `server/tests/manuscript-session-controller.test.js`

**Interfaces:**

```js
function createManuscriptFreshnessLifecycle({
  preStartVerifier,
  feedAdapter,
  notificationCapability,
  writerTurns,
  recovery,
  fullRefresh,
  projectionAccess,
}) {
  return {
    createOwner(registryIdentity) {}, // sync inert branded owner; zero side effects
    async start(owner, registryIdentity) {}, // exact once per entry, config exit 后调用
    async assertSameBinding(owner, registryIdentity) {},
    async admit(owner, operation) {}, // operation(opaque admission), exact once
    async close(owner) {},             // frozen { disposition: 'CLOSED' }, exact once
  };
}

class ManuscriptSessionController {
  constructor({ lifecycleLeaseAdapter, registryAdmission, routeAdmissionVerifier, freshnessLifecycle }) {}
  async openSession(projectSelector) {}
  async admit(session, operation) {} // operation(freshnessAdmission)
  async close(session) {}
}

async function ensureProjectionCurrent(freshnessAdmission, writerTurn) {}
async function ensureReadableProjection(freshnessAdmission, query) {}
```

- [ ] 沿用 Task 8B 已有 deep-frozen registry identity 与 `lifecyclePlatformIdentity` validator，不把 registry 根改成 exact 四键，也不新增 clone/foreign identity 声明；只补验 own enumerable data `projectUid`/`projectInstanceId` 是 canonical UUID，并始终保存 registry callback 交付的原对象引用。`preStartVerifier.verifyBeforeFeedStart(fullIdentity)` 在 config lease 退出后消费该原引用并直接返回 exact frozen `{ changeFeedPlatformIdentity }`；该字段必须是 Task 9A exact 五键对象。真实 trusted path/identity derivation 只留 Task 14B，9C 不 live 重算、不接受 caller-built feed identity，也不声称验证一个外部 port 无法铸造给本模块的私有 brand。
- [ ] 七个 constructor ports 都必填并在任何 side effect 前验证：`preStartVerifier` 如上；`feedAdapter.assertIdentity(startBasis.changeFeedPlatformIdentity)` 必须先返回同一引用，`tryOpen()` 才可按 capability 分支产生 Task 9A union；同步 `notificationCapability.read()` 只返回 boolean；`writerTurns.withWriterTurn(admission, callback)` 铸 opaque turn且 `assertTurn(admission, writerTurn)` 绑定同 owner/admission；`recovery.recoverBeforeRefresh(admission, writerTurn)`；`fullRefresh.validateAndPublish({ admission, writerTurn, claimSnapshot, baseToken })`；`projectionAccess.readCurrent(admission, query)` 与 `currentToken(admission)`。Task 9C 只用 exact fake ports，不导入 product/config DB 或预留 self-event/incremental seam。
- [ ] `fullRefresh` 输入只接受上面四个 exact frozen own data keys；`admission`/`writerTurn` 仍是同模块 authorities，`claimSnapshot` 必须是 9B 为 freshness 所持 opaque claim 返回的 exact frozen `{ baseGeneration, dirtyPaths }`，外部 port 不接收 claim。返回 Task 9B 定义的 exact frozen plain `COMMITTED | ALREADY_CURRENT | KNOWN_NOT_COMMITTED | UNKNOWN` union，成功 variant 携匹配的 generation，失败 variant 携原始 `error`，统一 `refreshKind='FULL'`。`COMMITTED` 表示确定发布新 generation；`ALREADY_CURRENT` 必须保持 generation/token 不变；`KNOWN_NOT_COMMITTED` 合回 dirty并原样抛 error，`UNKNOWN` 锁存 loss后原样抛 error。ordinary dirty 始终交 FULL，本计划不增加 `INCREMENTAL` producer。任何 full-after 无变化都必须返回稳定 `ALREADY_CURRENT`，不能每次 bump generation。
- [ ] `notificationCapability` 在 Task 17B final production capability 之前的 production composition 只能读出 false，此时不得调用 `feedAdapter.tryOpen()`，并以 `CAPABILITY_DISABLED` 进入 9B degraded owner；focused candidate 可用必填 true fake 覆盖 direct-feed 分支，但不能写 build-info 或声称 production true。true 时 `OPENED` 才建立三 feed；`NO_SLOT`/`UNAVAILABLE+KNOWN_CLOSED` 分别以 `NO_SLOT`/`KNOWN_UNAVAILABLE` 调用 `enterDegraded()`；`UNAVAILABLE+UNKNOWN`/own marker 立即 fence，不能返回 session或释放 shared 后重开。
- [ ] registry callback 内只做 shared acquire、route verify，并在 route verify 成功后的下一次 `await` 前同步调用 `createOwner()`、安装唯一 inert owner/deferred `startPromise`；不得在 config lease 内运行 pre-start verify、capability check、打开 feed、取得 writer 或扫描。callback 退出后，首次 opener 才驱动 `start(owner, originalIdentity)`：它在首个 `await` 前登记 owner-private startup admission，再执行 pre-start verify → pure feed identity assert → capability branch → feed arm（若启用）→ `withWriterTurn(startupAdmission)` 下 recovery/full baseline → 排空校验窗口，并在 `finally` 结清 startup admission。所有 joiner 等同一 promise，完成前 opaque session 不暴露。每个 joiner 都保留并重验自己的原 identity，调用 `assertSameBinding(owner, fullIdentity)` 比较 project/lifecycle/feed binding 后才能共享 owner。
- [ ] `start/admit/close` 都是 module-branded async exact-once 操作；controller shared entry 是 owner 唯一 owner。`admit()` 必须在首个 `await` 前由 freshness owner 同步登记 project gate，再向 operation 传 opaque admission，并在 `finally` 唯一撤销；gate 计数只由 owner 线性化，session controller 不维护第二份。非最后 session close 只关闭自身，不拆 feed。
- [ ] `ensureProjectionCurrent(admission, writerTurn)` 无 options，先用 `writerTurns.assertTurn()` 证明 Task 9D 已持同一 turn，禁止内部二次 acquire；随后 recovery，并以固定顺序同步 drain 每项 native completion：platform take → 9B observe/unarmed → platform rearm → 9B recordRearm → platform decode → 规范 relative dirty/loss 进入 9B account → platform retire，循环到同一 `gateSnapshot()` 无 signaled event且 observed=accounted；任一步失败都先 account/latch loss，绝不拼 clean。再 claim、在 freshness 内保留该 opaque authority、通过 `claimSnapshot()` 取 frozen data，并只把 snapshot 交 `fullRefresh`；结果仍由 freshness 使用原 claim 调 `settleRefresh()`。Task 9C 不做 self-event 对消或增量；失败、取消、`KNOWN_NOT_COMMITTED` 合回 dirty，`UNKNOWN`/错 generation/port throw 锁存 loss。读路径只有观察 dirty/loss 时才由 9C 内部 `withWriterTurn(admission, callback)` 调用同一函数。
- [ ] 已运行 feed 的 rearm/decode/platform 调用失败不允许借 `enterDegraded()` 假装换 mode：先结清可证明的 completion/account、锁存 loss并原样失败，保留 native owner直到 zero-ref cleanup。live close→degraded 需要新的 mode epoch/完整 state replacement，明确后移；本任务不得在失败后继续以 event clean 服务。
- [ ] `projectionAccess.readCurrent(admission, query)` 必须在同一 admitted SQLite connection 内完整序列化查询并返回 exact frozen `{ token: { generation, connectionEpoch, basisDigest }, value }`；`currentToken(admission)` 返回同形 exact token。direct-feed clean 路径在 readCurrent 前后各做一次 Task 9B gate snapshot并比较 currentToken；`DB_CONNECTION_STALE` 丢弃结果并从整个 readable gate 重入，其他错误原样传播。direct 与 degraded 两条读取路径合计都只允许一次完整重试，第二次仍 stale/变化则报 `MANUSCRIPT_TREE_CHANGED_DURING_READ`。
- [ ] capability=false/`NO_SLOT`/known-unavailable fallback 永不以 event clean：writer turn 内 full-before（允许 COMMITTED/ALREADY_CURRENT）→ `readCurrent` → writer turn 内 full-after（无变化必须 ALREADY_CURRENT）→ `currentToken`，只有 read token 与 after token 的 generation/connectionEpoch/basisDigest 全同才返回；否则按上一条唯一重试预算重入。owner 始终全脏并输出 frozen degraded status，UI 留 Task 15。
- [ ] 普通 session close 只有在减 ref 前满足 `sessionRefs == 1 && reservations == 0` 才启动 teardown：首个 `await` 前原子把 entry 置 stopping/releasing 并安装唯一 `cleanupPromise`，新 reserve 必须等待整条 feed close → shared release。存在 pending reservation 时当前 session 可关闭/减 ref但不得拆 owner；reservation 转 session 后按新的最后-close 条件处理，reservation 失败后若达到 post-accounting `sessionRefs == 0 && reservations == 0`，由同一 cleanup 函数安装/复用唯一 promise。cleanup 阻新 gate、等 owner gates、逐 feed cancel/terminal→observe/account→retire，再要求 platform/state known closed；随后才减最后 ref（若尚未减）并 Task 8A release shared。任一未知态 sticky fence、无 shared release、无 closed。
- [ ] Task 9C 只交付 freshness/session candidate 与 local focused 证据，不修改 build-info、不设置或广告 production `manuscriptChangeNotification = true`，不运行 full/build/VM。
- [ ] 运行并提交：

```powershell
bun test --timeout 60000 server/tests/manuscript-freshness.test.js server/tests/manuscript-session-controller.test.js
git diff --check
git add server/manuscript/freshness.js server/tests/manuscript-freshness.test.js server/manuscript/session-controller.js server/tests/manuscript-session-controller.test.js
git commit -m "feat: maintain manuscript projection freshness"
```

---

## Task 9D: 建立 admission/freshness wrapper

**Depends on:** Task 7B + Task 9C。此任务不得修改任何 REST、AI、导出、自动保存或产品入口；Task 7B 的 L2 service 也只作为 callback 后端，真实写入、冲突 gate、ignored 动作与迁移/创建/退役产品接线统一推迟到 Task 14B。

**Files:**

- Create: `server/manuscript/product-gates.js`
- Create: `server/tests/manuscript-product-gates.test.js`

**Interfaces:**

```js
function createManuscriptProductGates({
  projectSessionAdmission,
  writerTurns,
  freshness,
  turnContextSource,
  policy,
}) {
  return {
    async withCurrentManuscriptWriteTurn(projectSelector, writeRequest, callback) {},
    async withReadableManuscriptProjection(projectSelector, query) {},
  };
}
```

- [ ] 五个 ports 都是必填 exact methods，并在任何 admission/writer/freshness 副作用前验证。`projectSessionAdmission.withAdmission(projectSelector, operation)` 只借用 Task 14B 管理的长生命周期 session admission；9D 不 open/close session、不得每请求拆 feed/重做 startup FULL。Task 9D 基线的 `writeRequest` 是 exact frozen own-data `{ logicalRequestId, policyInput }`：ID 为非空字符串，`policyInput` 保留原 opaque 引用且不 clone/求值，供 Task 11A/14B 判断正文、sidecar、卷 metadata 与结构资源域。Task 14B 有意在同一提交修改 `product-gates.js` 与其 tests，把该合同升级为 exact 三键 `{ logicalRequestId, policyInput, writeIntent }`；此前任务不得提前接受第三键。
- [ ] `withCurrentManuscriptWriteTurn()` 的唯一顺序是 `withAdmission → writerTurns.withWriterTurn()` 恰好一次，并在同一 writer callback 内执行 `ensureProjectionCurrent(admission, sameTurn) → turnContextSource.capture(...) → policy.authorizeWrite(...) → callback(turnContext)`；不得二次 acquire、释放后再取、在 freshness/context/policy/callback 间留无锁窗口，或接受 caller-built admission/turn。任一 port 重复调用 callback 都在第二次 freshness/领域 callback 前拒绝。
- [ ] `turnContextSource.capture(Object.freeze({ admission, writerTurn, logicalRequestId }))` 是 9D 唯一上下文来源，返回 exact recursively frozen Task 7B 六键 `{ journalId, logicalRequestId, projectedAt, currentProjection, fileSnapshot, ignoredLedger }`：`journalId` 为 canonical UUIDv4，`projectedAt` 为 canonical UTC millisecond ISO，logical ID 逐字节回显，file snapshot 保留同一 ManuscriptStore opaque 原引用。source 自己拥有 production CSPRNG/clock；9D 不拼字段、不重扫文章树。本任务只用 fake 证明 mandatory contract；真实 source 必须在 Task 14B 证明 file snapshot、compact basis、ignored ledger、project/instance 与 generation `B` 来自同一已刷新 writer turn。
- [ ] `policy.authorizeWrite(Object.freeze({ admission, writerTurn, policyInput, turnContext }))` 成功只接受 exact frozen `{ disposition:'ALLOWED' }`；deny、throw、额外键/accessor/truthy 均 fail-closed，领域 callback 为 0。真实 DraftConflictJournal policy 留 Task 11A/14B，client dirty registry 只在 Task 15 的 host preflight 接线；9D 不伪装为已实现。
- [ ] callback 开始前 admission/writer/freshness/context/policy 任一步失败时，本 logical request 的新 FilePublicationJournal candidate 调用数为 0，且不清 dirty/claim/conflict evidence；freshness recovery 仍可处理既有 journal，policy 后续也可持久化其自身冲突证据。callback 一旦进入 Task 7B/10B1/10B3 并完成 `stageAssets()`，后续失败允许留下非终态 publication journal并沿用原 recovery；9D 不回滚、不吞原错、不自动重试，也不得再宣称 journal 零副作用。no-op 是否零 journal 仍由 Task 7B 保证。
- [ ] `withReadableManuscriptProjection()` 只执行 `projectSessionAdmission.withAdmission(projectSelector, admission => freshness.ensureReadableProjection(admission, query))`，原样返回结果/错误；它不取 writer、不调用 policy/context source、不重复 ActiveManuscriptProjection 或 retry，generation/connection epoch 与唯一重试预算继续由 9C 独占。本任务不把任何现有产品读入口宣称为已迁移。
- [ ] 本任务不修改静态扫描器或 SQL guard，也不建立临时 allowlist；文章真值 SQL、受控文件直写、freshness 绕过、tombstone 读取、`MAX(num)` 与旧伏笔编号的完整 RED→零债务扫描统一在 Task 14B 与产品接线同一次完成。
- [ ] focused RED→GREEN 覆盖 happy 顺序/逆序释放、各 stage 短路、context exactness与同引用、policy ALLOWED gate、callback 开始后的 journal recovery 边界、重复 callback 以及 readable 原样传播；删除无真实 source 的 fake service/第二次 projection 调用。本任务只跑下面的 focused wrapper test；不跑 full/build/VM，不修改 build-info 或 capability。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-product-gates.test.js
git diff --check
git add server/manuscript/product-gates.js server/tests/manuscript-product-gates.test.js
git commit -m "feat: establish L2 product gate foundation"
```

---

## Task 10A1: 规范化 ignored identity ledger 与 observation compiler

**Depends on:** Task 2 + Task 3 + Task 5 + Task 7B。本任务是纯 ledger/Store/target 合同，不依赖 Task 9C/9D，可与 freshness 实施并行。

**Files:**

- Create: `server/manuscript/ignored-ledger.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/projection-store.js`
- Modify: `server/manuscript/l2-service.js`
- Modify: `server/native/durability-schema.js`
- Create: `server/tests/manuscript-ignored-ledger.test.js`
- Modify: `server/tests/manuscript-store.test.js`
- Modify: `server/tests/manuscript-projection-store.test.js`
- Modify: `server/tests/manuscript-schema-12.test.js`
- Modify: `server/tests/manuscript-service-l2.test.js`
- Modify: `server/tests/manuscript-uid-reservation.test.js`

**Interfaces:**

```js
const IGNORED_MEMBER_SNAPSHOT_VERSION = 1;

class IgnoredIdentityLedger {
  toValidationEntries(rows, baseGeneration) {}
  compileAfter({ beforeRows, observations, targetGeneration }) {}
}
```

- [ ] `active | revoked` 行仍使用 Task 5 的 exact schema-12 标量键，但 `member_snapshot_json` 只接受唯一 canonical JSON：root exact `{ version: 1, members }`；chapter 成员角色固定按 `chapter_body, chapter_sidecar`，volume 固定为 `volume_index`。absent member exact `{ role, present: false }`；present member exact `{ role, present: true, byteSize, fileIdentity, parentIdentity }`，两个 identity 都是 exact `{ dev, ino }` 规范十进制字符串（只能是 `0 | [1-9][0-9]*`）。额外键、accessor、稀疏/错序成员、非 canonical JSON 或任一身份/大小异常都拒绝；`projection-store.js` 仍是 `canonicalIgnoredLedgerDigest()` 的唯一导出和摘要实现，只复用 ledger 模块的唯一 row/member normalizer，不复制排序或 digest material。normalizer 产物由 ledger 模块私有品牌标记且递归冻结；同模块 compiler/digest/internal target validation 必须 O(1) 识别并复用该规范数组，cold/rehydrated plain rows 才重新完整解析、排序。
- [ ] 修正 indexed ignored volume 无法表示的合同漏洞：`opaque_container_kind` 增加 `manuscript`。exact 交叉约束为 volume+indexed 只能 `manuscript/null`，chapter+indexed 只能 `unassigned/null | volume/canonical-volume-uid`，detached 必须 kind/uid 都为 null；`durability-schema.js` 的离线 schema-12 descriptor 与 `projection-store.js` 纯 validator 使用同一语义。本任务不打开项目数据库、不实现 Task 12 NativeProjectStore/SQL DML。
- [ ] `IgnoredIdentityLedger.toValidationEntries()` 唯一把完整 rows 变换为 Task 3 `validateFull()` 使用的 compact `{ kind, status, uid }` entries，并逐行核对 base generation。Task 3 仍不理解 SQL row，但 ignored observation 必须扩展为 exact `{ kind, uid, status, members, reference }`；`reference` 只能是 exact `{ state:'indexed', containerKind:'manuscript'|'unassigned'|'volume', containerUid:null|canonical-volume-uid }` 或 `{ state:'detached', containerKind:null, containerUid:null }`，并执行与 resource kind 相同的交叉约束。它只能从同一次已校验索引闭包推导，不接受 caller container。active ignored 资源仍枚举规范形状、实名、非 reparse、link count、大小与普通文件身份，并纳入容量；只跳过 UTF-8/JSON 内容语义解释。
- [ ] `compileAfter()` 是 Task 3 candidate `ignoredLedgerAfter` observations → Task 5 完整 target rows 的唯一 compiler：本任务中每个 before row 必须有且只有一个同 status observation，用它重建 canonical member/reference，并统一绑定 target generation；缺行、额外行、重复行、错 status/kind/uid/generation 或 observation/member/reference 不一致全部 fail-closed。Task 10A1 不铸造也不接受 ledger action/transition authority；Task 10A2 才在同一模块内扩展 Store-validated `new_active | reactivate | revoke` 三种 branded transition。Task 3 candidate 保持 generation-neutral observation，Task 5 保持 SQL-shaped rows，不让两份可独立变异的 ledger 与 capacity/candidate 拼成同 generation target。
- [ ] `projection-store.js` 把 Task 5 既有 `buildTarget({ ..., ignoredLedger, ... })` 参数固定解释为完整 **before rows**：先重算它的 canonical digest并匹配 `currentProjection.basis.ignoredBeforeDigest`，逐行匹配 base generation，再仅调用上述 `compileAfter({ beforeRows: ignoredLedger, observations: candidate.ignoredLedgerAfter, targetGeneration })` 产生 target after rows；必须把 Store candidate 内的 observations 数组原引用交给 compiler，不能 clone 后丢失后续 Task 10A2 的 transition provenance。`l2-service.js` 保留同名 `ignoredLedger` 调用面，但删除现有 base→target generation 预重绑定，只把已独立快照、已核对 digest/base generation 的 before rows 原样交给 `buildTarget()`；调用者不再能另传 SQL-shaped after ledger，target 中的 ignored rows 也只能来自该 compiler，从而消除 candidate observations 与独立 after rows 的双真值。
- [ ] focused RED 固定为：① canonical row/member JSON、单一 digest material 与 branded normalization 复用；② chapter volume/unassigned/detached 及 volume manuscript/detached 交叉约束；③ ignored present/absent metadata、零语义内容读取与容量；④ Task 3 observation → compiler → Task 5 target 的 before-digest/generation/member/reference 一致性，并拒绝独立 after-row 注入；⑤ ignored 与同 kind lifecycle active/tombstone UID 重叠在任何枚举/I/O 前拒绝，revoked/未知/孤儿仍 fail-closed。只跑下列 focused tests，不跑全量 suite、build 或 VM：

```powershell
bun test server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-schema-12.test.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-uid-reservation.test.js
git diff --check
git add server/manuscript/ignored-ledger.js server/manuscript/store.js server/manuscript/projection-store.js server/manuscript/l2-service.js server/native/durability-schema.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-schema-12.test.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-uid-reservation.test.js
git commit -m "feat: normalize ignored manuscript identities"
```

---

## Task 10B1: 实现 ignored-aware serializer、非创建结构命令与 opaque reference 动作

**Depends on:** Task 7B + Task 10A1。不依赖后移的 Task 10A2、Task 11A/11B/12；本任务只交付可注入 backend，不接产品入口。

**Files:**

- Modify: `server/manuscript/l2-service.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/ignored-ledger.js`
- Modify: `server/tests/manuscript-service-l2.test.js`
- Modify: `server/tests/manuscript-store.test.js`
- Modify: `server/tests/manuscript-ignored-ledger.test.js`

**Additional interfaces:**

```js
ignoredLedger.serializeOpaqueMembers({
  container,
  knownMembers,
  rows,
  referenceTransition,
})
// container exact union:
//   { kind:'manuscript', uid:null }
// | { kind:'unassigned', uid:null }
// | { kind:'volume', uid:canonicalUuid }
// referenceTransition exact union:
//   null
// | { resourceKind:'chapter', resourceUid:canonicalUuid,
//     fromContainer:{kind:'volume',uid:canonicalUuid}|{kind:'unassigned',uid:null},
//     toContainer:{kind:'unassigned',uid:null}|null }
// 非 null transition 必须带 ignored-ledger module-private WeakSet brand。

ignoredLedger.createReferenceTransition({ rows, observation, action })
// action exact union:
//   { kind:'ignored.preserve_move_to_unassigned', chapterUid:canonicalUuid }
// | { kind:'ignored.detach_reference', chapterUid:canonicalUuid }
// 只由 ignored-ledger 在 module-private WeakSet 登记并返回 branded frozen transition。

manuscriptStore.buildClosure(validatedFileSnapshot, mutation, ignoredRows)
// 结构/卷索引写会从同一 branded snapshot + canonical before rows 生成唯一 after tree。
```

**Exact command table:**

```js
{ kind: 'chapter.move', chapterUid, targetVolumeUid, targetPosition }
// targetVolumeUid: canonical UUID | null；targetPosition: 0-based known-only insertion index。

{ kind: 'chapter.reorder', containerVolumeUid, chapterUids }
// containerVolumeUid: canonical UUID | null；chapterUids 是该容器全部 known active 章节的 exact permutation。

{ kind: 'volume.reorder', volumeUids }
// volumeUids 是全部 known active 卷的 exact permutation。

{ kind: 'chapter.delete', chapterUid }
{ kind: 'volume.delete', volumeUid }
// volume.delete 级联 tombstone 尚留在该卷的全部 known active 章节，不接受 childPolicy。

{ kind: 'ignored.preserve_move_to_unassigned', chapterUid }
{ kind: 'ignored.detach_reference', chapterUid }
```

- [ ] 新结构命令只接受上表 exact enumerable own-data 字段：UID 必须规范，数组必须 dense/unique；extra/accessor/caller path/ref/ledger/reservation/port 在 Store、journal 与文件 I/O 前拒绝。`chapter.move.targetPosition` 必须是 `0 <= value <= target known active length` 的 non-negative safe integer，且只表示不含 opaque 成员的 0-based insertion index；它保留 compact basis/`localIdentityPlan` 中的原 `num`，目标 active 容器已有同 `num` 时在 journal 前 fail-closed，不自动改号、不抽 reservation。源与目标容器相同时拒绝 `chapter.move`，必须改用完整 permutation 的 `chapter.reorder`。
- [ ] `serializeOpaqueMembers()` 只规范化 rows 一次，并只接受接口冻结的 exact container union。它只验证 `knownMembers` 是 dense、canonical UID、unique 且与 opaque 无 overlap，保留其领域顺序，再将该容器 `active + indexed` opaque UID 按 UTF-8 字节序追加；detached/revoked/其他容器不追加。known active 集合的**完整 permutation** 必须在调用 serializer 前由 Store 对同一 branded snapshot 验证，serializer 不得另猜该集合。所有索引 after 都必须调用这一 serializer，包括 `chapter.move/reorder/delete`、`volume.reorder/delete`、两个 ignored 动作，以及 Task 7B 已有但会重写卷索引的 `volume.patch_metadata`；不得从 projection 单独重建索引或复制第二份 opaque 排序逻辑。
- [ ] ignored reference 变更时，Store 只能把同一 branded validated snapshot 的 same-turn `observation`、canonical before `rows` 与 exact `action` 交给 `createReferenceTransition()`；只有 ignored-ledger 自己能校验 active row/current container、在 module-private WeakSet 铸 brand并返回 frozen transition，Store/caller 都不能登记 brand 或传自造 transition/container/after rows。exact transition 只允许 volume→unassigned 的 preserve，或 volume/unassigned→null 的 detach；resource kind/UID、from/to 任一额外键或错配都拒绝。同一 transition 同时驱动 serializer 的 virtual after container 与 candidate `ignoredLedgerAfter` observation，禁止手造 SQL-shaped after 或分别改两份状态。`preserve_move_to_unassigned` 只接受 active+indexed-in-volume ignored chapter，exact closure 是原卷索引 + `unassigned.json`；`detach_reference` 只接受 active+indexed ignored chapter，exact closure 是原卷或 `unassigned.json`。两者均不读取语义内容，不移动/删除资源对。
- [ ] `buildClosure()` 前必须证明 canonical `ignoredRows` 与同一 branded snapshot 的 ignored observations 是 exact bijection：长度相等，双方 `kind + uid` 唯一且双向完全覆盖，再逐项比较 identity、status、canonical members 与 reference；任一缺失、额外、重复或字段差异都在 file boundary、journal 与其他副作用前拒绝，不能只做 rows→observation 单向查找。
- [ ] 每个命令先构造一份 linear structured after tree（known volume order、每容器 known chapter order、metadata/resource presence、同一 ignored observations），再一次线性派生 canonical index bytes、最小 closure、完整 candidate、`volumePosition/chapterPosition/manuscriptPosition`、controlled facts 与 capacity。不允许通过多次 splice/reindex 或“先 closure、后宽松 merge candidate”形成第二结构真值；after 字节未变时在 `stageAssets()` 前返回 no-op，journal 调用数为 0。
- [ ] `chapter.delete` 闭包只含归属索引 + 章节资源对 delete；`volume.delete` 闭包含 `manuscript.json`、卷索引 delete 和尚留的 known active 子章节资源对 delete，子章节需保留时必须先用独立 `chapter.move` 完成。若该卷仍承载任一 active+indexed ignored chapter，在 closure 读/CAS、journal 事件和文件副作用前返回 `IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE`。delete 只从 target active rows 移除并由 Task 5 生成 tombstone，不释放生命周期 UID。
- [ ] capacity 从同一 structured after 计算：delete 减少当前 controlled file/bytes 与章节目录项，但 chapter/volume identity 不减；为 Task 10B3 预留的 create delta 只允许对应 kind identity `+1`，chapter create 目录项 `+2`，volume create 不改 chapter directory entries。硬上限在 journal 前拒绝，80% identity warning 随 candidate 持续；ignored 成员仍纳入文件/字节容量，不得因 serializer 去重或 delete 释放。
- [ ] focused RED→GREEN 覆盖 exact command 表、完整 permutation、同号 move 阻断、七类最小 closure/tombstone/no-op、`volume.patch_metadata` opaque tail、known+opaque 稳定序列化、`createReferenceTransition()` API/brand/非法 action、rows↔observations exact bijection、卷删除阻断、capacity delta 与 stale 零 journal。本任务不跑全量 suite、build、VM/13/19 或 production acceptance。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-service-l2.test.js server/tests/manuscript-store.test.js
bun test --test-name-pattern "serializeOpaqueMembers|createReferenceTransition" server/tests/manuscript-ignored-ledger.test.js
git diff --check
git add server/manuscript/l2-service.js server/manuscript/store.js server/manuscript/ignored-ledger.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-store.test.js server/tests/manuscript-ignored-ledger.test.js
git commit -m "feat: compile ignored-aware manuscript structures"
```

---

## Task 10B2: 实现 ordinary journal request lookup、reservation read/assert/source

**Depends on:** Task 6 + Task 7A。本任务只扩展现有 FilePublicationJournal parser 与共享 UID manifest 验证，不添加事件 suffix/state/fault point，不执行 create 编排或产品恢复。

**Files:**

- Modify: `server/manuscript/uid-reservation.js`
- Modify: `server/manuscript/file-publication-journal.js`
- Modify: `server/tests/manuscript-uid-reservation.test.js`
- Create: `server/tests/file-publication-reservation-recovery.test.js`

**Additional interfaces:**

```js
function validateIdentityReservationManifest(value) {}
// 唯一 pure exact validator；UID core 与 Journal 共用，返回 canonical recursively-frozen manifest。

function canonicalCreateLogicalInputDigest(command) {}
// 唯一 pure create-command canonicalizer；返回 lowercase 64-hex SHA-256。

fileJournal.lookupOrdinaryRequest(logicalRequestId)
// null，或 exact frozen { state, outcome, identityReservation, reservationBinding }
// outcome: early | advanced | after | before
// reservationBinding exact keys:
// { projectUid, projectInstanceId, journalId, logicalRequestId,
//   baseGeneration, targetGeneration, basisDigest, logicalInputDigest,
//   inputDigest, reservationDigest }

fileJournal.readReservation({ journalId, logicalRequestId })
// 仅 early assets_reserved | target_reserved 返回 { identityReservation, authority }。

fileJournal.assertReservation({ authority, identityReservation, journalId, logicalRequestId })
// 返回 lookup/read 中同一 exact frozen reservationBinding。

fileJournal.reservationSource()
// 返回 stable frozen { enumerate(scope) } adapter，输出 UID core exact complete scoped snapshot。
```

- [ ] `canonicalCreateLogicalInputDigest(command)` 是 create command 的唯一 canonicalizer，`l2-service.js` 与 UID core 只能 import 它。摘要 material 是 UTF-8 canonical JSON 且 key 顺序固定：volume 为 `{domain,version,kind,title,summary}`；chapter 为 `{domain,version,kind,containerVolumeUid,requestedNum,content,sidecar}`，其中 sidecar key 顺序固定为 `title,outline,status,summary,cognitive_frame,emotional_anchor,world_texture,concrete_mystery,interpersonal_tension`；`domain = "mythpen.manuscript.create-logical-input"`、`version = 1`，输出 lowercase 64-hex SHA-256。helper 只接受 Task 10B3 两个 exact command shape；禁止在 service、manifest validator 或 Journal 内建立第二个 command canonicalizer。
- [ ] `validateIdentityReservationManifest()` 成为 `reserved_new` manifest 的唯一 material/`reservationId` 验证器：exact domain/version/assignment kind/object kind/project UID+instance/logical request/source basis/UID/ID/path predicates 全验；chapter 还必须精确保存 final `num`、`containerVolumeUid` 与原 create command 的 `requestedNum`（`null | positive safe integer`），三者都纳入唯一 `reservationId` material。manifest 只验证、保存已由唯一 helper 产生的 canonical `logicalInputDigest`，不保存 title/content/sidecar 正文，也不从 manifest 自行重建 command digest。`ManuscriptUidReservation.reserveNewIdentity()` 接受这一 digest 并用 validator 铸造 manifest；`assertReservation()`、Journal parser 与 source adapter 只复用 validator，不复制 key/material/checksum。依赖方向只是 Journal→UID pure exports，不引入 UID→Journal 循环。
- [ ] `lookupOrdinaryRequest(logicalRequestId)` 只从 constructor-bound project/ControlStore 完整事件链查找，并把 ordinary 精确限定为调用合同 `parent === null`、持久形状 `{ kind:'ordinary', journalId:null }` 且 `mode = 'full'`；`draft_conflict` 虽同为 full 也绝不进入 lookup/source。真正无匹配事件才返回 null；同 logical ID 出现于多 journal、file-only/非创建 reservation、冲突 payload 或无法分类链均 fail-closed。state/outcome 映射固定为：`assets_reserved | target_reserved → early`，`prepared | files_published | projection_committed → advanced`，`completed → after`，`rolled_back → before`；`assets_collected` 必须沿完整前缀链证明原 terminal disposition再返回 after/before，不得只看末事件猜测。每个非 null 结果都从完整链返回接口所列 exact `reservationBinding`；`targetGeneration` 属于 journal binding，不得从 identity manifest 猜测。lookup 纯读、不追加事件、不读文章树。
- [ ] `readReservation()` 只在 journal 完全不存在时返回 null；只为与 exact ordinary request/project 绑定的 early 状态铸造 opaque resume authority。advanced/after/before/损坏不得伪装成 null 或 early：advanced 必须交 Task 6 `recover()`，after/before 交 Task 10B3 重放/拒绝。`assertReservation()` 重读同一事件链，只验证 persisted authority/manifest 引用以及 project/request、base/target generation、basis、allocation、logical-input/input/reservation digest 的内部一致性，返回与 lookup/read 逐字段相同的 exact `reservationBinding`；此时不接收也不验证新 closure/path。它不绑全局 tail，允许合法 asset-ready/其他 journal 追加。
- [ ] `stageAssets()` 只在 `mode = 'full' && parent === null && identityReservation !== null` 的 ordinary create 分支先调唯一 `reserved_new` manifest validator；ordinary non-create 必须保持 `identityReservation === null`。fresh append 或 early exact replay都在任何新事件/recovery asset 前，用 build-once closure 重新计算 Journal 唯一 `inputDigest`，再把 persisted binding/manifest 与该 full-mode ordinary create closure 双向绑定：project/instance/request/generation/basis/allocation 逐项相等，object kind/UID 与全部 before-absent create refs 完全对应，path predicates 与 Task 3 `paths.js` 重新派生的 final path/role/parent identity 逐字节相等，且 closure 其余 update/delete 成员只是同一结构命令所需索引。同一 warm validator 还必须复用 Task 3 已有 canonical JSON/UTF-8 authority 从 exact create after bytes 重建 volume `title/summary` 或 chapter `content/sidecar`，chapter 的 container/requested number 只取 validated manifest 中的 `containerVolumeUid/requestedNum`，再调用唯一 `canonicalCreateLogicalInputDigest()` 并与 manifest digest 逐字节比较。不得往 ControlStore 写入正文、建第二 command canonicalizer，或用 final `num` 猜 `requestedNum`。错 logical input/input digest/kind/UID/path/parent/closure 或 caller path 均在 append/asset 前拒绝。`file_only` 继续只服从 Task 6 既有 parent reservation/pin authority 与它自身的 identity plan；Task 10B2 不用 `reserved_new` validator 拦截、重解释或改写该通用分支。
- [ ] `reservationSource().enumerate(scope)` 只接受 exact `{ projectUid, projectInstanceId, objectKind }`，返回现有 UID core 的 exact `{ complete:true, projectUid, projectInstanceId, objectKind, records }`；record 只来自调用合同 `parent === null`、持久 ordinary parent、mode=`full` + non-null validated `reserved_new`，明确排除 draft-conflict full journal。从 `assets_reserved` 到 `completed | rolled_back` 均保留碰撞记录，只有完整链已进入 `assets_collected` 才按 after 已被 active/tombstone 接管或 before 已安全释放而从 source 移除。file-only、identity-null 与其他合法 journal 不输出record，但任一损坏/未知/重复 UID、reservation、owner 或 logical request 使整个 snapshot fail-closed；不允许 default-empty。
- [ ] 本任务不新增 journal 状态、恢复资产或 crash point。focused RED→GREEN 只覆盖 create logical-input digest/manifest 唯一性、chapter `requestedNum = null | explicit` 的 reservationId 区分、fresh volume title/summary 与 chapter content/sidecar 漂移在 append 前拒绝、lookup 重启/重复 logical ID、early read/assert authority 不可互换、advanced/terminal 不伪装 early、project/request/generation/basis/input/closure/path 漂移、ordinary non-create 拒绝 non-null reservation，以及 `file_only` non-null parent identity plan 不被 `reserved_new` validator 误拦截的分支回归与 source/GC 状态表。不重跑 Task 6 全部 journal/crash suite、全量 suite、build、VM/13/19 或 production acceptance。
- [ ] 运行并提交：

```powershell
bun test server/tests/file-publication-reservation-recovery.test.js
bun test --test-name-pattern "create logical input digest|identity reservation manifest" server/tests/manuscript-uid-reservation.test.js
git diff --check
git add server/manuscript/uid-reservation.js server/manuscript/file-publication-journal.js server/tests/manuscript-uid-reservation.test.js server/tests/file-publication-reservation-recovery.test.js
git commit -m "feat: recover ordinary manuscript reservations"
```

---

## Task 10B3: 编排 ordinary create reservation 与结果重放

**Depends on:** Task 10B1 + Task 10B2。本任务只使 chapter/volume create 在 injectable backend 上可恢复；Task 12 才交付 production path probe/source adapters，Task 13 补 ProjectCreationJournal source，Task 14B 才接 composition root 与产品入口。

**Files:**

- Modify: `server/manuscript/l2-service.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/tests/manuscript-service-l2.test.js`
- Modify: `server/tests/manuscript-store.test.js`
- Modify: `server/tests/file-publication-reservation-recovery.test.js`

**Additional interface:**

> **快速可用版范围裁决（覆盖本任务旧的过度证明要求）：** Task 12 仍按 12A schema/route/native、12B UID/Store snapshot、12C MigrationJournal/service 三块并行，但只做一次整体 final review、一个提交。首版只保证 source SQLite 在完整成功前只读、side-by-side schema12 candidate、generation CAS、最终单次原子 route switch、journal checksum+幂等重试、受控路径/reparse 防护和一个代表性 crash/restart。任一现场无法明确证明时保留 source/candidate/用户稿件并返回 `RECOVERY_REQUIRED`，不为自动清理继续扩状态机。

> **本版明确后移：** 自动 abort 目录/锁回收、partial-delete 恢复、schema12 bounded GC/checkpoint、route-cache 增量一致性、每章 `data_version` 技术更新的完美单次增长、每个状态前后强杀、每层重复 prototype/accessor/exact-key/WeakMap authority 与自动证明全部 before/after/unknown。只在 composition 边界验证一次 `MigrationContext`，内部传递同一原引用。新测试预算固定为一个表驱动 happy path、三个核心 invariant 负例、一个代表性 crash/restart；同一非法输入只在 authority owner 测一次，跨层只留一个 integration case。

```js
function createL2ManuscriptService({
  manuscriptStore,
  fileJournal,
  projectionStore,
  uidReservation,
  uidPathProbe,
}) {
  return {
    bindWriteIntent(command) {},
    writeIntentAuthority() {},
    execute(writeIntent, turnContext) {},
  };
}

// writeIntentAuthority() 返回同一 service 的 stable frozen capability：
// { assert(writeIntent), describe(writeIntent) }
// describe() 返回 exact frozen
// { family:'ordinary_create', logicalInputDigest:lowercase64Hex }
// | { family:'non_create', logicalInputDigest:null }

manuscriptStore.buildClosure(
  validatedFileSnapshot,
  mutation,
  ignoredRows,
  identityReservation,
)
// Task 10B3 把 Task 10B1 三参数合同升级为上述 exact 四参数版：
// non-create 必须显式传 null；create 由 service 传入已经对应 authority 验证的原 manifest 引用。
// Store 本身只负责 canonical frozen value/command/path 双向绑定，不伪称能从 serializable value 辨认逐字节相同 clone。
```

**Exact create commands and result:**

```js
{ kind: 'volume.create', title, summary }

{
  kind: 'chapter.create',
  containerVolumeUid, // canonical UUID | null; null = unassigned
  requestedNum,       // positive safe integer | null
  content,
  sidecar: {
    title,
    outline,
    status,
    summary,
    cognitive_frame,
    emotional_anchor,
    world_texture,
    concrete_mystery,
    interpersonal_tension,
  },
}

// volume success
{ state: 'created', objectKind: 'volume', uid, id, targetGeneration }
// chapter success
{ state: 'created', objectKind: 'chapter', uid, id, num, targetGeneration }
```

- [ ] 两个 create command 只接受上述 exact enumerable own-data 字段：所有文本是 string，chapter `status` 只能是四个规范状态，sidecar 不接 `format_version/chapter_uid`，caller path/ref/UID/reservation/port/position/extra/accessor 全拒绝。`volume.create` 追加到 known volume tail，`chapter.create` 追加到目标容器 known chapter tail；随后都由 Task 10B1 serializer 追加 opaque tail，不插入 opaque 之后。
- [ ] `bindWriteIntent(command)` 是纯同步零 I/O preflight：必须复用 `execute()` 同一个 `snapshotMutation`/exact command validator，把规范化 command 递归冻结并登记到 service-private WeakMap；create descriptor 精确为 `{ family:'ordinary_create', logicalInputDigest }`，digest 只调用 Task 10B2 唯一 `canonicalCreateLogicalInputDigest()`，其余已支持命令精确为 `{ family:'non_create', logicalInputDigest:null }`。返回的 write intent 自身递归冻结但不暴露 command/descriptor；caller path/authority/family/digest/extra/accessor 在绑定前拒绝，且不得触发 Store、journal、source、RNG、probe 或文件 I/O。
- [ ] `writeIntentAuthority()` 只返回同一 service 的 stable original frozen capability；`assert()` 只接受该 service WeakMap 中的原 write intent，`describe()` 先执行同一 assert 再返回冻结 descriptor。plain/clone/foreign service/错 receiver/伪 descriptor 全部拒绝。`execute(writeIntent, turnContext)` 不再接 raw command，只能在首个 I/O 前经同一 capability 取回私有 frozen command，因此 preflight intent 与 callback command 不存在可替换双输入；Task 7B/10B1 的既有非 create 路径也在本提交统一改走 intent。
- [ ] 五个 ports 在任何 lookup/source/RNG/probe/Store/journal 调用前一次 exact 验证；`uidPathProbe` 是 constructor-bound `{ probe() }`，不从 command/turnContext/caller 逐次传入。service 先 assert write intent、从私有记录取得已冻结 exact command/descriptor 并 snapshot turn；create 的 `logicalInputDigest` 只能沿用 bind 时由 Task 10B2 唯一 helper 计算的 descriptor 值，不得在 execute 建第二 canonicalizer。然后在 `uidReservation.reserveNewIdentity()`、reservation source 枚举、CSPRNG 和 path probe **之前**调用 `fileJournal.lookupOrdinaryRequest(logicalRequestId)`；查到旧 request 时不得使用 turn 新生成的 proposed journal ID 开第二条链。
- [ ] lookup 的任何 non-null outcome 在 recover、replay、Store 或其他副作用前，都必须用同一 pure gate 逐项比较 persisted project/instance/logical request、`identityReservation.objectKind` 与当前 create kind，以及 `reservationBinding.logicalInputDigest` 与 bind 时的同一 command digest。异 command/digest 、错 project/instance 或不匹配 object kind 都必须在 `recover()` 前零 Store/RNG/source/probe/journal/projection 拒绝，不得先改 generation 或把旧结果冒充当前请求。该通用 gate 不得把 terminal replay 的 durable base/target generation 或 basis 与当前更高 generation 强行相等；这些字段只用于证明持久结果自身与 recover 前后的不变绑定。lookup=null 的 fresh 路径才调 `reserveNewIdentity({ kind, logicalRequestId, currentProjection, ignoredLedgerBefore, allocation, pathProbe: uidPathProbe, logicalInputDigest })`；先用 UID core `assertReservation()` 验证 fresh authority，再进入 Store。lookup=early 则只从 `lookup.reservationBinding.journalId` 调 `readReservation()` + Journal `assertReservation()`，并在上述通用 gate 之外将同一 exact binding 与当前 base/target generation、basis 和 allocation 逐项比较；这一阶段不把新 closure/path 传给 assert。fresh authority 不得交 Journal assert，resume authority 不得交 UID core assert，两向替换在 Store/资产/事件前拒绝。
- [ ] fresh/early 都只调升级后的 `ManuscriptStore.buildClosure(snapshot, command, ignoredRows, identityReservation)` **恰好一次**：non-create 在该提交统一显式传 `null`；create 只传 UID core `assertReservation()` 或 Journal `assertReservation()` 已验证的同一 original manifest 引用，这一 same-reference provenance 由 service 的 opaque authority 检查负责。Store 先要求 manifest 是 recursively frozen plain data，再调唯一 pure manifest validator，并将 validated snapshot、canonical before ignored rows、exact command 与 manifest 双向值绑定；Store 必须拒绝 malformed/mutable/noncanonical/异 command manifest，但不复制一套 brand、不声称能识别逐字节相同的 canonical clone。随后才从 Task 10B1 linear structured after 生成 create closure/candidate。chapter closure 是两个 before-absent 资源成员 + 目标索引；volume closure 是 before-absent 卷索引 + `manuscript.json`。create 返回空 closure 永远是合同错误，不得复用 non-create `{state:'noop'}`。新资源 before endpoint 必须精确为 absent + `fileIdentity:null`，`parentIdentity` 只取 manifest 中同 role path predicate；candidate template 的新 controlled facts 在 finalize 前 physical identity 只能为 null，随后只能由 exact same-ref/hash/size/parent staged fact 注入。capacity 执行 Task 10B1 冻结的 identity/directory/file/byte delta；越界、错 predicate parent 或 staged identity/parent 在 journal/publish 前 fail-closed。
- [ ] 唯一 fresh/early 调用序是 `lookup → fresh reserve/core.assert 或 early read/journal.assert → buildClosure once → stageAssets(same identityReservation) → finalizeCandidate → buildTarget → bindTarget → prepare → publishFiles → commitProjection → complete → lookup(after)`。early 的 closure/path/Journal `inputDigest` 双向校验只发生在 `stageAssets()`，并必须早于其 append/asset；service 不得把这一步提前塞进 reservation assert。create 的 `localIdentityPlan` 在 Task 7B 全部 `reuse_uid` 之外只追加同一 manifest 的一条 `reserved_new`，按 object kind+UID 稳定排序；UID/ID/num/reservationId/source basis 任一漂移 fail-closed，不二次抽号或把 tombstone/ignored 当新身份接管。`complete()` 的返回值不是 create result authority；它成功后必须立即二次 `lookupOrdinaryRequest()`、重跑上述通用 persisted-intent gate 并要求 `outcome='after'`，最终结果只从这个耐久 assignment + `targetGeneration` 构造。lookup 缺失/仍 non-after/字段漂移一律 `RECOVERY_REQUIRED`，不回显 in-memory manifest 或 complete payload。
- [ ] lookup=advanced 在上述通用 persisted-intent gate 通过后不重建 closure/target，只从 `lookup.reservationBinding.journalId` 调 Task 6 `recover()` 并重读 lookup；重读结果再次通过同一 gate 后才可分类。此外，recover 前的 full `reservationBinding`（project/instance/journal/request/base/target generation、basis/logical-input/input/reservation digest）与 canonical `identityReservation`（含 UID/ID/num/requestedNum/container/path predicates/reservationId）必须冻结为 witness；recover 后除 `state/outcome` 允许单调前进外，上述 persisted witness 必须逐项不变，任一替换或漂移都 `RECOVERY_REQUIRED`。未能证明 after/before 也同样 `RECOVERY_REQUIRED`。lookup=after（包括 completed 后已 `assets_collected`）从耐久 validated assignment 与 `lookup.reservationBinding.targetGeneration` 重放接口冻结的 exact frozen create result，RNG/source/probe/Store/新 journal 调用数均为 0；fresh success 也只从 complete 后二次 lookup 的最终持久 binding 构造该结果，因此 fresh 与 cold replay 每字段相同。lookup=before（rolled_back 或其后 collected）也先通过通用 gate，再稳定拒绝同 logical ID 并要求新 `logicalRequestId`，不复用旧 assignment、不重抽。
- [ ] 本任务的恢复边界只覆盖 injectable service：测试前提是 upstream 已保留 matching logical request 的 `assets_reserved | target_reserved`，然后证明本地 lookup/read/assert/build-once/stage replay；本任务不修改 Task 9C freshness/product gates，也不声称产品 cold-start 闭环。`prepared+` 在 service 观察到 advanced 时仍交 Task 6 前滚/判定，terminal 只供 replay/GC。Task 12 提供 production source/probe；“generic recovery 不得先 rollback matching early”的产品协调明确后移 Task 14B，由其 composition 以同一 Task 10B2 分类器接线。
- [ ] focused RED→GREEN 覆盖两个 exact create shape、`bindWriteIntent()` 零 I/O、descriptor 与 plain/clone/foreign/wrong-service authority 拒绝、authority-only execute、known-before-opaque append、capacity/alias/path collision、lookup-before-RNG/source/probe、fresh/resume authority 双向不可互换、service cloned authority/manifest pair 拒绝、Store 第四参 malformed/mutable/noncanonical/异 command manifest 拒绝（不伪造 canonical clone 品牌）、create 空 closure 不得 no-op、create before `fileIdentity:null`/predicate parent 与 staged identity/parent 精确注入、build-once/call order/complete 后二次 after lookup、upstream 已保留 early 前提下的本地 resume、advanced recover 前 intent gate 与 recover 前后 full persisted witness 不变、after/before binding/result 逐字段重放、terminal replay 不强绑当前更高 generation、同 logical ID 异 object kind/command digest 在 recovery/任何副作用前拒绝，以及任一失败停止。不跑全量 suite、build、VM/13/19 或 production acceptance。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-service-l2.test.js server/tests/manuscript-store.test.js server/tests/file-publication-reservation-recovery.test.js
git diff --check
git add server/manuscript/l2-service.js server/manuscript/store.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-store.test.js server/tests/file-publication-reservation-recovery.test.js
git commit -m "feat: create L2 manuscript identities recoverably"
```

---

## Task 11A: 实现 server DraftConflictJournal core

**Depends on:** Task 6。这里只交付耐久 journal、backup ownership 与 opaque evidence 状态转移；writer/freshness、accept projection CAS、apply child 编排和产品 route 严格后移 Task 14B。

**Files:**

- Create: `server/manuscript/draft-conflict-journal.js`
- Create: `server/tests/draft-conflict-journal.test.js`
- Create: `server/tests/draft-conflict-crash.test.js`
- Create: `server/tests/fixtures/draft-conflict-crash.js`
- Modify: `server/control-store.js`
- Modify: `server/tests/control-store.test.js`

**Interfaces:**

```js
class DraftConflictJournal {
  createConflict(input) {}
  readConflict(conflictId) {}
  listConflicts() {}
  beginAccept(input) {}
  beginApply(input) {}
  recordAcceptResolved(intent, projectionAfterEvidence) {}
  recordApplyResolved(intent, childAfterEvidence) {}
  recordApplyAborted(intent, childBeforeEvidence) {}
  supersede(input) {}
  archive(input) {}
  recover(conflictId) {}
  listGcDebt() {}
}
```

```text
conflict_detected → backup_durable → decision_ready(epoch = 0)
  → resolve_accept_intent(epoch) → resolved_accept_external → archived
  → resolve_apply_intent(epoch)
      → resolved_apply_draft → archived
      → resolve_apply_aborted → decision_ready(epoch + 1)

backup_durable | decision_ready | resolve_accept_intent（projection 仍精确为 before）
  → superseded
```

- [ ] constructor exact 必填 `{ controlStore, projectBinding, backupStorage, childDisposition, projectionDisposition, uuidV4, clock }`；先一次验证全部 ports，随后把 project UID/instance、ControlStore directory/incarnation 与规范 `<project_instance_id>/` 根逐项绑定。`uuidV4` 只在首次 create 使用；`clock` 仅允许在首次 create 与每次 `listGcDebt()` 开始时各取样一次，恢复/重放不得重取。plain/clone/foreign intent/evidence 不能推进状态。
- [ ] event prefix 固定 `draft_conflict`、version=1；每个 payload 都是 exact frozen plain data并重复绑定 project UID/instance、conflict ID、resource `{ kind:'chapter'|'volume'|'manuscript', uid, domain:'body'|'sidecar'|'volume_metadata'|'structure' }`、decision epoch。`conflict_detected` 额外冻结 `supersedes|null`、base generation、base/external/draft lowercase SHA-256、sizes、canonical unique field mask、backup layout digest 与创建时间；事件与诊断永不含 draft/external bytes。
- [ ] `createConflict()` 只接受 exact bytes/resource/basis input；先在项目 ControlStore 写 `conflict_detected` 作为 `<draft-conflict>/<conflict_id>/` 唯一所有权证据，再让 constructor-bound `backupStorage` create-new 写固定 `draft.bin`/`external.bin`/`manifest.json`，逐文件 fsync、目录 fsync、父目录 fsync、handle-bound identity/hash/readback 完整后才追加 `backup_durable` 与 `decision_ready(0)`。任何 checksum/identity/parent/flush receipt 缺失都不得向 caller 返回 ready。
- [ ] 在首个 conflict 副作用前，把 exact `draft-conflict` 安装为 ControlStore 第二个保留 plain non-reparse 目录名；只忽略容器内部，仍拒绝同名文件、symlink/junction、大小写/近似名和其他未知根项。Task 11A 只消费 narrow `backupStorage` capability，不把任意 mkdir/path 能力暴露给 caller；production storage capability 的 zero-injection composition 留 Task 14B。
- [ ] `beginAccept()`/`beginApply()` 只接受当前 `decision_ready(epoch)`，分别先耐久写 exact `resolve_accept_intent`（accepted hash/resource/base+target generation）或 `resolve_apply_intent`（唯一 child FilePublicationJournal ID、external hash CAS、base+target generation）再返回 module-private opaque intent。旧 epoch、迟到重试和旧 child 在任何 downstream effect 前以 `PROJECTION_STALE` 拒绝。
- [ ] `record*` 与 `recover()` 只消费同 journal 重读后由 constructor-bound disposition ports 铸造的 opaque evidence：accept after 才写 `resolved_accept_external`；apply child 完整 after 才写 `resolved_apply_draft`；完整 before 依次写 `resolve_apply_aborted` 与 `decision_ready(epoch+1)`；other/unknown/证据漂移统一 `RECOVERY_REQUIRED`。apply intent 绝不能直接 supersede；accept 已提交必须先补 resolved audit，后续变化另建 conflict。
- [ ] `conflict_detected` 且 backup 不完整时，recover 只在 root ownership event + storage exact incomplete/无外部内容证据同时成立时清理该 run-owned 子目录并留下 deterministic debt；`backup_durable` 只补首个 ready，ready 等待用户。`superseded` 与 `archived` 是终态且 backup 保留；本小提交只由 `listGcDebt()` 以持久化的 `conflict_detected.createdAt` 为年龄基准、使用本次唯一 clock 样本计算“最近20份或30天取较宽者”候选，**不物理删除**，crash-safe retention delete 留 Task 14B/16。
- [ ] 稳定错误矩阵：未解决冲突对产品 policy 是 `EXTERNAL_DRAFT_CONFLICT`；旧 epoch/迟到请求是 `PROJECTION_STALE`；第三现场、损坏、无法证明 before/after 是 `RECOVERY_REQUIRED`；details/diagnostics 只能含 ID、epoch、child、hash、size、field mask、state，禁止正文。
- [ ] 唯一 RED 矩阵覆盖 wrong project/incarnation 零副作用、reserved directory 的 file/link/case variants、backup file/parent fsync 前后、规范单跳/unknown/duplicate/payload drift、旧 epoch、accept/apply opaque evidence、resolved/aborted/terminal cold recovery 与 GC debt；不扩到真实 writer/freshness/projection/route，不跑 full/build/VM。运行并提交：

```powershell
bun test server/tests/draft-conflict-journal.test.js server/tests/draft-conflict-crash.test.js
bun test --test-name-pattern "ControlStore reserves manuscript draft-conflict directory" server/tests/control-store.test.js
$task11aJs = @('server/manuscript/draft-conflict-journal.js', 'server/tests/draft-conflict-journal.test.js', 'server/tests/draft-conflict-crash.test.js', 'server/tests/fixtures/draft-conflict-crash.js')
foreach ($task11aFile in $task11aJs) { node --check $task11aFile; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
git diff --check
git add server/manuscript/draft-conflict-journal.js server/tests/draft-conflict-journal.test.js server/tests/draft-conflict-crash.test.js server/tests/fixtures/draft-conflict-crash.js server/control-store.js server/tests/control-store.test.js
git commit -m "feat: record manuscript draft conflicts"
```

---

## Task 11B: 实现 client dirty-resource registry core

**Depends on:** 无 server 依赖。这里只交付纯进程内 registry；真实 editor/debounce/unloaded/title/sidecar/structure/multi-window producers 与 conflict UI 接线留 Task 15。

**Files:**

- Create: `src/lib/dirtyResourceRegistry.ts`
- Create: `tests/dirtyResourceRegistry.test.ts`

**Interfaces:**

```ts
type DirtyResourceIdentity = Readonly<{
  projectUid: string;
  projectInstanceId: string;
  resourceKind: "chapter" | "volume" | "manuscript";
  resourceUid: string;
  domain: "body" | "sidecar" | "volume_metadata" | "structure";
  windowId: string;
}>;

interface DirtyResourceRegistry {
  markDirty(identity: DirtyResourceIdentity, draft: Readonly<{
    revision: number;
    baseRawSha256: string;
    fieldMask: readonly string[];
    payload: JsonValue;
  }>): void;
  markSaving(identity: DirtyResourceIdentity, revision: number, requestId: string): void;
  settle(identity: DirtyResourceIdentity, revision: number, requestId: string,
    result: "saved" | "stale" | "failed"): void;
  snapshot(): ReadonlyArray<DirtyResourceState>;
}

type JsonValue = null | boolean | number | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

type DirtyResourceState = Readonly<{
  identity: DirtyResourceIdentity;
  revision: number;
  baseRawSha256: string;
  fieldMask: readonly string[];
  payload: JsonValue;
  status: "dirty" | "saving" | "stale" | "failed";
  requestId: string | null;
}>;
```

- [ ] identity/request/draft 都只接受 own enumerable exact data：UUID 必须 canonical，window/request ID 非空，revision 为递增 positive safe integer，hash 为 lowercase SHA-256；field mask dense/unique/canonical，payload 只允许有限 JSON data。registry 在方法返回前深拷贝并递归冻结，caller 后续 mutation/getter/prototype 不能改变内部状态。
- [ ] key 精确包含 project UID+instance、resource kind+UID、domain 与 window ID；同名 replacement、不同项目实例、不同窗口和不同资源域绝不串状态。同 key 新 revision 覆盖旧 draft但保留完整最新 payload/mask/base hash；旧 revision 不能重新变成 current。
- [ ] `dirty A → saving(A,r1) → dirty B → settle(A,r1,saved)` 必须保留 B。只有匹配当前最新 revision+request 的 `saved` 可清；`stale|failed`、错 request、迟到 success 都保留 evidence。snapshot 稳定排序且不泄露可变 payload。
- [ ] 本任务不修改 Zustand store、EditorContent、save queue、Outline、API 或 UI，不宣称完整 producer 已接线；这些 Files 与“已加载/卸载正文、sidecar、卷 metadata、structure、多窗口”验收统一留 Task 15。唯一 RED 覆盖上述 revision/request/window/project-instance 交错、deep freeze 与 exact input；不扩测试。运行并提交：

```powershell
node --test --test-concurrency=1 tests/dirtyResourceRegistry.test.ts
pnpm typecheck
git diff --check
git add src/lib/dirtyResourceRegistry.ts tests/dirtyResourceRegistry.test.ts
git commit -m "feat: track manuscript dirty resources"
```

---

## Task 12: 实现 SQLite→files MigrationJournal

**Depends on:** Task 9D。

**Files:**

- Modify: `docs/superpowers/plans/2026-08-17-l2-file-authority.md`
- Modify: `server/native/durability-schema.js`
- Modify: `server/native/native-project-store.js`
- Modify: `server/native/native-sql-authorization.js`
- Modify: `server/testing/native-stage-b-fixture.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/uid-reservation.js`
- Create: `server/manuscript/uid-reservation-sources.js`
- Create: `server/manuscript/route-store.js`
- Create: `server/manuscript/migration-journal.js`
- Create: `server/manuscript/migration-service.js`
- Modify: `server/tests/manuscript-schema-12.test.js`
- Modify: `server/tests/native-project-store.test.js`
- Modify: `server/tests/manuscript-uid-reservation.test.js`
- Create: `server/tests/manuscript-route-store.test.js`
- Create: `server/tests/manuscript-migration-crash.test.js`
- Create: `server/tests/fixtures/manuscript-migration-crash.js`

**Additional interface:**

```js
class ManuscriptRouteStore {
  constructor({ journalAuthority }) {}
  readRoute(projectDb) {}
  verifyAfterLease(projectIdentity) {}
  prepareCompareAndSwap(projectDb, expected, next, binding) {} // opaque one-shot routeCas
}

// 由真实 NativeProjectStore/内部 adapter 实现；Task 5 只依赖这个 port。
class NativeManuscriptProjectStore {
  publishRouteTransition({ routeCas }) {} // initial fence / proven abort only
  publishProjectionTarget({ target, routeCas }) {}
}

class ManuscriptUidReservation {
  reserveMigrationIdentities({ migrationId, projectInstanceId, sourceBasis, projectRootProbe }) {}
  resumeMigrationIdentities({ journalAuthority, migrationReserved, sourceBasis }) {}
  assertMigrationIdentities({ authority, migrationReservation, localIdentityPlan }) {}
}

// Task 6 projectionDisposition port 的唯一真实实现。
class NativeProjectionDisposition {
  inspectTarget({ target, journalEvidence }) {} // base | target | other
}

// Task 6 parentAuthority 的 migration 真实实现；只消费耐久 MigrationJournal。
class MigrationFilePublicationParentAuthority {
  assertReservation({ authority, parent, childReservation }) {}
  assertPin({ authority, parent, manifest }) {}
  readRecoveryIntent({ authority, parent, assetManifest }) {} // complete pin -> after; otherwise RECOVERY_REQUIRED
}
```

**State model:**

```text
migration_reserved → route_fenced → source_snapshot_ready
→ files_candidate_ready → file_publication_started → files_published
→ database_candidate_ready → activation_intent → activated

首版不实现自动 abort/cleanup 路径；无法幂等前进时保留现场并返回 RECOVERY_REQUIRED
```

- [ ] `ManuscriptRouteStore` 构造时固定注入 module-branded、只读 `journalAuthority`；`readRoute()`、`verifyAfterLease()` 与 `prepareCompareAndSwap()` 都只能消费该 authority 的同一冻结观察，caller 不能逐次替换 journal 或传入 journal 状态自证。`routeCas` 是 module-private one-shot authority，精确绑定同一 DB/ControlStore identity、project UID/instance、generation、journal 原观察、expected/next 与 transition proof；plain/clone/foreign/stale/重复消费零 DML。
- [ ] schema 11 的 route/journal admission 冻结为四态矩阵：① 四个 L2 保留键全缺且无非终结 MigrationJournal，才是普通 implicit `sqlite`；② 四键全缺且存在唯一、精确匹配的 `migration_reserved`，只允许恢复安全终结 reservation，普通入口不接纳；③ 四键完整、route=`migrating` 且绑定同一 journal 的 `route_fenced` 或后续规范状态，普通入口稳定返回 `PROJECT_MIGRATION_BUSY`，只允许迁移/恢复/诊断；route CAS 已耐久但 journal 仍停在 `migration_reserved` 的崩溃窗口，只能由 `journalAuthority` 凭同一 CAS 证据先前滚为 `route_fenced` 后归入本项；④ 其余缺键、重复、显式 sqlite、非法组合、多个/错误 journal 或身份不符一律 `MIGRATION_STATE_MISMATCH`。schema 12 inspector 继续精确要求全部十个 `project_meta` 行，缺失 `manuscript_route` 或任一其他必需行都 fail-closed，绝不回退为 sqlite。
- [ ] `verifyAfterLease()` 是 Task 8B verifier contract 的真实实现，复核 files route、project UID/instance、数据库/文章根物理身份、projection generation 与“存在则成功终态”的 parent journal；Task 14B 只能注入这一实例，不能用 live schema snapshot、caller facade 或产品侧 callback 替代。
- [ ] 初始 route fence 与已证明 abort 只能由 `publishRouteTransition({ routeCas })` 消费内部 authority，最终 activation 则只能由 `publishProjectionTarget({ target, routeCas })` 在同一事务消费；两者不得交换 token 用途。`db.js` 以私有 WeakMap 绑定 `projectDb → NativeManuscriptProjectStore`，不暴露原始 SQL。协议化安全中止在相同 guard 下以一次 native 原子事务删除全部四个 L2 保留键，恢复 D7 的 legacy implicit sqlite；只有事务已知提交且 journal 已规范终结后才重建 config cache，不能把 cache 值反写项目数据库。Native parser 必须经同一 `journalAuthority` 精确验证仅出现在 clean L1 边界的 MigrationJournal events，并把它们作为链内 neutral events；禁止 catch/skip unknown event。
- [ ] `config.db` route cache 的增量一致性/自动重建后移 Task 14B；Task 12 的成功证据只来自项目 SQLite 内的单次原子 route switch，不读取或回写 cache 自证成功。
- [ ] “稍后升级”测试 route、journal、reservation、目标根与业务字节零变化；未显式实验启用时不弹默认迁移、不创建 files 项目。
- [ ] 用户确认前完成 dirty draft 处理、云同步/reparse 风险说明、备份确认；确认后在 registry/config lease + writer lease 下写 `migration_reserved`。
- [ ] 扩展 Task 7A 的同一个 `ManuscriptUidReservation`，本任务只建立 registry、现存 roots 与全部未 GC MigrationJournal 的真实 source adapters；不得在 migration service 内实现第二套扫描或抽号逻辑，也不得用尚未接线的 source 默认空集合。唯一 `reserveMigrationIdentities()` 在全局 project namespace 预留 project UID，并在同一 L1 项目的 chapter/volume namespaces 中批量铸造 `bind_legacy`；serializable manifest 精确包含 project reservation、`migrationId`、`projectInstanceId`、`sourceBasisDigest` 与按 kind+UID UTF-8 稳排的 Task 5 `bind_legacy` rows。每个 `reservationId` 的摘要 material 必须包含 migration/source basis/source ID+num/UID。逐行保留 source volume/chapter ID 与章节 `num`，不得把 legacy row 冒充 `reserved_new`或重新分配本机 ID/num。同 migration ID 必须先 lookup；`resumeMigrationIdentities()` 只从耐久 `migration_reserved` + 同 source basis 恢复，零 RNG；`assertMigrationIdentities()` 把 original authority、manifest 与 final localIdentityPlan 双向绑定，持久化后碰撞不得重抽。ProjectCreationJournal source 由 Task 13 增加，ordinary create 的完整 source composition 只在 Task 14B 建立。
- [ ] MigrationService 只注入并消费上述明确的 migration source set，并把 adapters 暴露给后续 composition；本任务不修改任何 ordinary service 或产品 root。聚焦测试只验证 migration `bind_legacy` 与已存在/未 GC migration reservations 共用碰撞域；Task 13 再补 creation source，Task 14B 才把 ordinary `reserved_new`、migration `bind_legacy` 与 creation reservation 组合为完整联合域。
- [ ] reservation 在 route fence 前落盘并冻结；同 migration ID 的重试逐项复用；落盘后碰撞返回 `UID_RESERVATION_COLLISION`，绝不重抽。
- [ ] route fence 是 reservation 之后第一个目标副作用；`migrating` 下所有普通入口返回 `PROJECT_MIGRATION_BUSY`。
- [ ] 本任务实现唯一真实 `projectStore.publishProjectionTarget({ target, routeCas })` adapter，供 Task 5 的稳定 port、普通 files 投影发布和迁移最终激活共同复用，并实现 Task 6 必填 `projectionDisposition.inspectTarget({ target, journalEvidence })` 的唯一真实只读 adapter；`projection-store.js` 不再修改。`inspectTarget()` 必须在已验证 writer/project/journal authority 下完整读取后精确返回 `base | target | other`：`base` 逐项比较 project UID/instance、journal binding、base generation、调用 Task 5 唯一 helper 重算的 canonical compact basis digest、basis rows、两表 sequence、`ignoredBeforeDigest` 和 pending `{revisionId, chapterId}`；`target` 逐项比较同一绑定与完整 target after predicate；任一字段、row、digest、authority 或读取完整性无法证明均为 `other`。它必须零业务 DML、零 route/cache 修改，禁止只凭 generation 相等推断任一 disposition 或接受 caller disposition。publish adapter 先把 target 的 `projectUid`/`projectInstanceId` 与已 admission 私有项目绑定逐项比较；随后 import Task 5 唯一的 `canonicalProjectionBasisDigest()`/`canonicalIgnoredLedgerDigest()`，在任何业务 DML 前只重读 compact basis 所需列、两表 sequence、完整 ignored-before、pending `{revisionId, chapterId}` 与 base generation；schema11 正文逐行流式算 UTF-8 hash后即释放，不建立第二份正文集合。adapter 用同一 helpers 构造 compact basis并比较 digest，禁止复制 material/排序/canonicalizer；未出现在 target active fields/tombstone refs 的 local columns 必须原位保留。再由注入的 journal/reservation authority 验证三类 `localIdentityPlan`；assignment/source/basis/reservation/ID/num、项目/实例、generation 或 target 重放任一错配都 fail-closed。`routeCas` 缺失只允许普通 files projection；存在时由同一 NativeProjectStore 私有 brand 消费并与 transition 同 commit。
- [ ] 真实 schema 12 publish 在一个 NativeProjectStore 事务内完成 generation CAS 与全部 target DML。对会改变容器/编号/活跃状态的章节，第一阶段先让受影响 active 行退出两个活跃编号部分唯一索引并清空 `chapter_position`/`manuscript_position`，第二阶段再写最终 `volume_id`、保留或预留的 `num`、连续 positions、`is_present` 与 `deleted_at`；任何阶段都不得向外暴露中间态。章节、卷和不可物理删除的 ignored 身份账本只允许 insert/update/tombstone，真实路径禁止 `DELETE FROM chapters`、`DELETE FROM volumes` 或删除 ignored identity row。
- [ ] 首版不为两阶段技术更新另造 `data_version` 完美单次增长机制；保持 schema 11 原触发器与业务更新语义，schema12 candidate 只要最终 rows/generation 与结构完整即可。该优化与精确 per-row 增长证据后移，Task 12 不扩测。
- [ ] 本任务先扩展 Task 2 的 v2 descriptor/inspector，再由 schema 12 candidate builder 重建 `chapter_revisions` 的 status CHECK，正式加入 literal `stale`，并逐行保留全部既有 revision、主键、`sqlite_sequence`、外键和 `idx_chapter_revisions_active`；schema 11 的表定义与允许值保持不变。真实 `publishProjectionTarget` 只执行 Task 5 从重验 basis 与 candidate 派生并冻结在 exact target 中的 literal `pending → stale` 集：正文变化/删除和 sidecar `status` 变化与完整 projection 同 commit，纯移动/重排或其他 metadata 变化不更新 proposal，accepted/rejected/superseded/stale 行不被重写；caller 不能另传、删减或扩大 invalidations。
- [ ] 在 Task 2 的 v2 descriptor/inspector 上只建立一套 schema 12 candidate builder/installer。它接收已冻结且独立保留完整本机业务行的 source contract、完整 compact canonical dependency basis、Task 12 铸造并验证的 `bind_legacy` local identity plan、完整 target projection 与 `sourceKind = schema11 | empty`；migration 分支必须在唯一离线 candidate 上逐列保留业务行、整数 ID、`sqlite_sequence`、外键、视图与非冲突索引，重建 RESTRICT、物理 DELETE barrier、两个活跃编号部分唯一索引及全部 v2 canonical triggers，禁止 `CREATE TABLE AS SELECT`。UID、positions、raw hashes、ignored/容量快照和伏笔位置只能来自 frozen input，不得在 builder 内随机生成或从旧 `num` 猜测；`projectedAt` 必须是 target 已冻结且 round-trip exact 的 `YYYY-MM-DDTHH:mm:ss.sssZ`，恢复/重放不得重取时钟。
- [ ] builder 对 schema11 source 先做 v1 instance/seq/gate/digest 精确 preflight，再在事务外关闭 foreign keys、按依赖图于事务内重建、完成 `integrity_check`/`foreign_key_check`/ID 集合/行数/sequence/schema 指纹/v2 三方 digest 后提交并恢复 foreign keys；未知依赖返回 `SCHEMA_SWAP_UNSUPPORTED`。任一注入失败都恢复 PRAGMA 并只留下未发布 candidate，source DB 与 ControlStore 字节不变。
- [ ] 快速版保持 `PROJECT_SCHEMA_VERSION=11`、`SQLJS_PROJECT_SCHEMA_VERSION=10`，`db.js` 不变；Task 12 只交付 side-by-side schema12 candidate、v2 inspector、Native publish adapter、generation CAS 与最终原子 route switch，绝不让 live schema 自证可打开。Task 14B 在真实 MigrationJournal/ProjectCreationJournal composition 同时可用时才修改 `db.js`、把支持上限提升到 12，并以持久 `database_candidate_ready → activation_intent → activated` proof 接纳 schema12；在那之前普通入口继续零修改拒绝 schema12+。
- [ ] transition proof 精确绑定 kind=`migration | new_creation`、before/after schema 与 trigger digest、project instance、before/final commit seq、candidate identity、parent journal ID/digest 和 target generation。Task 12 实现并消费 `migration` kind；同时把 verifier/builder 作为 Task 13 的唯一 `new_creation` 接口，不新增平行 ControlStore 事件链。
- [ ] `native-sql-authorization.js` 与 sql.js guard 共同消费 Task 2 的四个 `RESERVED_PROJECT_META_KEYS`：普通业务 SQL 在 schema11 route fence 前后及 schema12 都不能插入、更新、删除或借 CTE/subquery/复杂 predicate 间接修改这些键；只有绑定同一 transition/journal 的内部语句可写。schema12 的章节/卷物理 DELETE 由 authorization 与 v2 barrier 双重拒绝，schema11 的 legacy sqlite 删除语义在 Task 14B 接线前保持不变。
- [ ] 把 Stage B fixture/store 改为显式 versioned fixture：既有 schema11 genesis、payload exact keys、18/54/digest 与全部测试值不变；schema12 fixture 必须由真实 v2 candidate + 持久 transition proof 建立，不能靠测试参数或 live schema 自证。用该 fixture 聚焦验证冷启动、cached open、事务 preflight、commit 后、recovery 与 transition 漂移拒绝。
- [ ] route fence 后由 MigrationJournal parent 创建或验证规范 lifecycle lock，并记录 before/after 身份及 file/parent flush 谓词；Task 8A adapter 只可 `OPEN_EXISTING`。随后建立一致源快照与迁移前备份，完成 integrity、foreign-key、旧章节编号、伏笔预期位置、schema 依赖、容量和目标缺席检查。只有这些谓词、源/备份身份与 SHA-256 全部冻结后才写 `source_snapshot_ready`；任何不明确分别返回对应 legacy/schema 错误，不能进入 child `assets_reserved`/`stageAssets()`。
- [ ] 本任务首次扩展 Task 7A 的同一个 Store compiler，增加只供 MigrationService 使用的 `migration.full_snapshot`：只接受 frozen schema11 source snapshot、`bind_legacy` plan 与已验证目标树/目录品牌，生成全量 canonical after 和 exact closure；caller 不能传文件名/路径/任意成员。同步实现 Store-backed name-index path probe adapter，只查询已验证的规范 UID/ref 索引并返回完整或 fail-closed，供 reservation core 使用；产品 composition 仍留 Task 14B。
- [ ] `route_fenced` 冻结 `<data>/manuscripts/<project_uid>/`、`mythpen/`、`volumes/`、`chapters/` 四级目录逐级 before/after canonical real identity、父身份、absent/owned 谓词和本 migration ID 所有权，且必须早于第一个 `mkdir`。parent 在进入既有 `source_snapshot_ready/files_candidate_ready` 阶段的动作中逐级创建并重新 canonicalize，fsync 每个新目录及其父目录；身份不符进入 `RECOVERY_REQUIRED`。不新增 `directories_ready` 等规范外状态。
- [ ] source snapshot ready 后先调用 Task 7A 扩展后的 `buildClosure()` **恰好一次**（纯读），随后 `files_candidate_ready` 在 child `stageAssets()` 前冻结该 exact closure/digest、唯一 caller-provided child journal ID、logical request、projection basis digest、共同 target generation、目标身份、files before/after 谓词和 child asset reservation；parent 不得创建第二个 child。重新读取该事件后由真实 authority 铸 `parentReservationAuthority`，再严格执行 `stageAssets → finalizeCandidate(stagedAfterFacts) → buildTarget → bindTarget`，不二次 build closure，也不让 service、Task 5 或后续 adapter 宽松 merge/补 physical identity。
- [ ] target 项目 ControlStore 目录下必须有唯一 canonical 项目级 recovery root `<data>/control/manuscripts/<project_uid>/<project_instance_id>/file-assets/`。MigrationService 在任何 child `assets_reserved` 前以本任务目录所有权 create-new/fsync/handle-verify ControlStore 根和 exact `file-assets` 容器，并把容器 identity 写入 target project binding；恢复只 `OPEN_EXISTING` 复核，绝不创建 per-journal 子目录。activated 后普通 Task 7B/10B1/10B3 writer 复用同一容器，退役前不得删除；asset GC 只删扁平 journal-owned 叶文件。
- [ ] `bindTarget()` 返回后，parent 把完整 serializable manifest、canonical digest 与 exact parent/child/project/generation/closure/target/assets binding 写入 `file_publication_started` 作为耐久 pin；重新读取并由本任务真实 `MigrationFilePublicationParentAuthority.assertPin()` 铸 authority 后，child 才能 `prepare → publishFiles`。child 完整 after 后 parent 才写 `files_published`，再调用唯一 builder 构造/验证 populated schema 12 physical candidate 和 transition proof。最终 NativeProjectStore publish 同时提交投影和 route；child 不写 projection/activation/parent 状态。
- [ ] child 只能向 parent 已建立且身份匹配的三个受控目录发布，永不创建目录。首版不自动回滚或删除已创建的目录、lifecycle lock、candidate 或 partial assets；任一不能幂等继续至完整 after 的现场保留全部证据并返回 `RECOVERY_REQUIRED`。源 DB 在成功 route switch 前始终只读，且永不删除用户稿件。
- [ ] 恢复顺序固定为：先恢复 L1 journal；联合加载 route 与唯一 MigrationJournal；处理合法 reservation；验证 `migrating`/`route_fenced`；完整 pin 前验证 child ID、parent reservation 与 partial manifest，正常状态幂等续 stage、abort intent 只铸 before；完整 pin 后验证 full manifest/pin 并从父耐久状态取得 branded before/after intent收敛 child；据 child 终态构造或丢弃唯一 physical database candidate；验证共同 after；最后写 `activation_intent` 并原子发布为 `activated`。plain goal、父子 ID/digest/generation 不一致、多个 child 或 candidate 不唯一都进入 `RECOVERY_REQUIRED`。
- [ ] crash 测试只留一个代表性窗口：已耐久 reservation/candidate，但最终 route switch 前退出；冷启必须复用同一 migration ID/UID/candidate 继续，或保留现场并明确 `RECOVERY_REQUIRED`。不再对每个 parent/child 状态前后强杀，不测自动 partial-manifest GC。
- [ ] 首版不自动进行 child asset GC、parent bounded GC/checkpoint 或 reservation/pin 解除；成功 `activated` 和任一不明现场都保留耐久 debt，由后续计划/手工恢复处理。CLI/REST 接线留 Task 14B。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-route-store.test.js server/tests/manuscript-schema-12.test.js server/tests/durability-schema.test.js
bun test --test-name-pattern "SQL classifier requires every|testing factory opens exact" server/tests/native-project-store.test.js
bun test --timeout 120000 server/tests/manuscript-store.test.js server/tests/manuscript-uid-reservation.test.js server/tests/manuscript-migration-crash.test.js
git diff --check
git add server/native/durability-schema.js server/native/native-project-store.js server/native/native-sql-authorization.js server/testing/native-stage-b-fixture.js server/manuscript/store.js server/manuscript/uid-reservation.js server/manuscript/uid-reservation-sources.js server/manuscript/route-store.js server/manuscript/migration-journal.js server/manuscript/migration-service.js server/tests/manuscript-schema-12.test.js server/tests/native-project-store.test.js server/tests/manuscript-uid-reservation.test.js server/tests/manuscript-route-store.test.js server/tests/manuscript-migration-crash.test.js server/tests/fixtures/manuscript-migration-crash.js docs/superpowers/plans/2026-08-17-l2-file-authority.md
git commit -m "feat: migrate projects to file authority"
```

---

## Task 10A2: 实现 projection-only ignore/revoke（后移）

**Depends on:** Task 9D + Task 10A1 + Task 12。只有 Task 12 的真实 projection adapter 完成后才开始；不用 fake publish 把两个产品动作提前宣称可用。

**Files:**

- Modify: `server/manuscript/ignored-ledger.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/projection-store.js`
- Modify: `server/manuscript/l2-service.js`
- Create: `server/manuscript/orphan-resolution-service.js`
- Modify: `server/tests/manuscript-ignored-ledger.test.js`
- Modify: `server/tests/manuscript-store.test.js`
- Modify: `server/tests/manuscript-projection-store.test.js`
- Modify: `server/tests/manuscript-service-l2.test.js`
- Create: `server/tests/manuscript-orphan-resolution.test.js`

**Interfaces:**

```js
class OrphanResolutionService {
  snapshotRequest(request) {}
  preflightResolution(action, request, baselineContext) {}
  publishResolution(preparedResolution, projectionContext) {}
}

canonicalSchema12ReuseIdentityPlan(currentProjection)
```

- [ ] `snapshotRequest(request)` 是两个动作共用的唯一纯同步 exact validator：own data 只接受 `{ kind:'chapter'|'volume', uid }`，返回递归冻结快照且零 I/O；不接受路径、member snapshot、identity、容器、容量或 caller-built record。Task 10A2 **只交付内部 preflight/投影动作，不接 product gates、freshness、route、API 或 UI**；产品可达性严格留 Task 14B。
- [ ] `preflightResolution(action, request, baselineContext)` 只接受 server-owned literal `ignore_in_place | revoke_ignore`、同一 Store 的 original branded baseline file snapshot、与 exact schema12 currentProjection generation `B` 匹配的 canonical before rows；plain/clone/foreign/stale context 全拒绝。它不得先拿 before ledger 调普通/public FULL：Store 必须在 unknown/revoked 分类前只把请求的 exact kind+UID overlay 为 pending active/revoked，随后对同一 tree 做**唯一一次**完整形状、pair、身份、索引闭包与容量扫描并铸 opaque prepared candidate。第二个 unknown、非目标结构/事实变化、错 UID/path/identity 或超限均零 publish；禁止 catch `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED` details 拼 row、二次扫描或 caller observation。
- [ ] `preflightResolution()` 返回的是同 service module-private opaque prepared authority，并冻结 action、request、original baseline 与唯一 scan 结果；`publishResolution(preparedResolution, projectionContext)` 只消费该原 authority。`ignore_in_place` 在无 before row 时铸 `new_active`、revoked before 时铸 `reactivate`，已经 active 且 after 无变化只返回稳定 no-op；`revoke_ignore` 只接受当前 active exact row，用 pending-revoked overlay 生成保留 UID/member snapshot 的 revoked after。plain/clone/foreign/stale/wrong-action prepared 在 adapter 前拒绝；发布后文件仍存在时下一次 ordinary FULL 继续以 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED` 阻断。
- [ ] Store 与 `ignored-ledger.js` 只在完整 preflight 成功后共同铸 exact `new_active | reactivate | revoke` module-branded transition，并绑定 before digest/generation、kind/UID、原 observations、capacity snapshot 与 original prepared candidate；plain/clone/foreign/stale 全部拒绝。Task 10A1 compiler 仍是 `buildTarget()` 内唯一 observation→after-row 路径；不得接受 caller rows/observations、复制 candidate、预编译第二份 ledger或从异常 details 拼 row。
- [ ] `projection-store.js` 是 reuse identity plan 的唯一 producer：`canonicalSchema12ReuseIdentityPlan(currentProjection)` 完整验证 exact frozen schema12 projection、canonical basis digest、active+tombstone 两表与 ID/num，按 objectKind+UTF-8 UID 稳排并递归冻结。现有 L2 service 与 OrphanResolutionService 都只调用该 helper；Task 12 adapter、Task 14B 和 caller 只验证/消费，禁止各自复制 plan 或注入 plain plan。
- [ ] `publishResolution()` 只把 prepared authority 内部的 original candidate、compiler after ledger/capacity、唯一 reuse plan 交 Task 12 真实 adapter做 base-generation/ignored-digest/target-generation CAS；`projectionContext` 只携同一 admitted writer turn 的 adapter authority，不允许 caller 注入 candidate/rows/plan。stale、known-not-committed、unknown 都保留原现场且零本动作文件副作用；本任务不创建 FilePublicationJournal，不移动/删除/重写用户文件，也不声明 product reachable。
- [ ] `preserveAndMoveToUnassigned` / `detachOpaqueReference` 以及内部 opaque-reference move/detach 都不属于本任务；它们是 Task 10B1 的结构闭包。本任务也不修改 freshness、route/CLI/UI 或产品 API，最终接线留 Task 14B/15。
- [ ] 唯一 focused RED 用 Task 12 真实 NativeProjectStore projection adapter fixture（禁止 fake publish）覆盖 request freeze/零 I/O、ordinary FULL 不参与、resolution scan 恰好一次、第二 unknown/错 target/stale/clone 零 publish、new_active/reactivate/revoke exact row、active no-op、stale/unknown 零文件副作用、revoke 后 ordinary FULL 再阻断，以及 reuse helper 拒绝 schema11/empty/stale/inexact/漏 tombstone且 L2/orphan得到同一计划；0C/0I final review 后禁止扩矩阵。不重跑 Task 12 全量 suite、full/build/VM：

```powershell
bun test server/tests/manuscript-orphan-resolution.test.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-service-l2.test.js
git diff --check
git add server/manuscript/ignored-ledger.js server/manuscript/store.js server/manuscript/projection-store.js server/manuscript/l2-service.js server/manuscript/orphan-resolution-service.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-orphan-resolution.test.js
git commit -m "feat: resolve ignored manuscript resources"
```

---

## Task 10P: OMITTED — 本计划不实现增量刷新

- [ ] 用户已明确裁决本计划不实现 self-event 对消或 incremental refresh。Task 9C/14B/16/17B 始终使用 ordinary-dirty → FULL baseline，不创建 `incremental-refresh.js`、不接 `selfEventProof/draftSafety/incrementalRefresh` ports，也不把 FULL 样本命名为 incremental。
- [ ] Task 17A 只测量并记录 full-only 成本；若最终性能证据明确表明必须实现增量刷新，只记录 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，并在本计划之外另立新计划，重开 composition root 与产品路由测试。不得在 Task 14B/16/17A/17B 中临时回填 Task 10P，也不得因此重复全量/VM 验收。


---

## Task 13: 实现 files 新项目的 ProjectCreationJournal

**Depends on:** Task 12。

**Files:**

- Modify: `docs/superpowers/plans/2026-08-17-l2-file-authority.md`
- Create: `server/manuscript/project-creation-journal.js`
- Create: `server/manuscript/project-creation-service.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/uid-reservation.js`
- Modify: `server/manuscript/uid-reservation-sources.js`
- Modify: `server/native/durability-schema.js`
- Modify: `server/manuscript/route-store.js`
- Modify: `server/native/native-project-store.js`
- Create: `server/tests/project-creation-journal.test.js`
- Create: `server/tests/project-creation-crash.test.js`
- Modify: `server/tests/manuscript-uid-reservation.test.js`
- Create: `server/tests/fixtures/project-creation-crash.js`

**State model:**

```text
creation_reserved → project_control_ready → file_publication_started → files_published
→ database_candidate_ready → activation_intent → activated（终态）

无法证明可安全前滚：保留 files/candidate/journal 现场并返回 RECOVERY_REQUIRED
```

- [ ] 快速版 parent journal 固定在 `<data>/control/project-creation/<creation_id>/`，事件带 canonical data checksum 并只接受上述七个线性状态；`activated` 是唯一终态。任一 unknown/malformed/stale 状态不猜测、不删除，统一 `RECOVERY_REQUIRED`。
- [ ] `ProjectCreationService` 注入并调用 Task 7A/12 的同一个 `ManuscriptUidReservation`。UID catalog 必须显式提供 frozen `creationSources`，每个 source 同时实现完整 enumeration 与 logical-request lookup；lookup 在 RNG、journal、`mkdir` 前执行。同一 logical request 从耐久 ProjectCreationJournal 复用原 creation ID/project UID，任一 source 缺失、不完整、冲突或校验失败都 fail-closed，禁止 default-empty 与第二套扫描/随机逻辑。
- [ ] 同一个 Store compiler 增加内部 `creation.empty_bootstrap`：只消费本 Store 最新 branded、无 canonical file/journal candidate/residue 的空 enumeration、frozen empty ignored rows 与 exact project identity；只产生 `manuscript.json` + `unassigned.json` 两成员 absent→canonical-empty closure/candidate，不接受 caller path 或第三个成员。
- [ ] creation parent authority 按真实 FilePublicationJournal `file_only` reservation/pin 接口校验 child ID、parent、project/instance、logical request、generation、basis 与 creation reservation。服务只执行一次 `buildClosure → stageAssets → finalizeCandidate → buildTarget → bindTarget → pin → prepare → publishFiles`，完整 child after 后才进入 database candidate。
- [ ] `buildSchema12Candidate()` 在原 canonical schema12 builder 上增加 exact `sourceKind:'empty'` + `transitionKind:'new_creation'` 分支；继续复用唯一 v2 DDL、trigger set、inspector 与 source/candidate path verifier。空 target 必须 generation `0→1`、两张受控空文件、零业务 projection rows，route 出生即 `files`，不得新建平行 DDL/parser/generator。
- [ ] final DB 在 activation 前必须 absent。`ProjectCreationRouteStore` 以 module-authentic context/observation/transition proof 铸 one-shot creation CAS，把 final-parent identity、candidate identity/SHA-256、creation/project/instance、journal tail、commit seq 与 generation `0→1` 绑定在同一次转换；`installCreatedProjectDatabase()` 只在 CAS 内完整复验 schema12 candidate 后调用既有 `installAbsentFromVerifiedSource()` 并 fsync parent。occupied/reparse/drift/ambiguous 均保留 candidate、files 与 journal，返回明确错误；不物理删除任何用户稿件。
- [ ] 本快速版只对 `database_candidate_ready`/`activation_intent` 提供前滚恢复，产品入口仍不可达并留 Task 14B。明确删除/后移：abort、child release、目录/candidate 自动清理、asset/parent GC、retention/checkpoint、`listed/completed`、recent/cache、启动入口恢复、session/feed 与逐状态强杀；不修改 `db.js`、`recent-projects.js`、`file-publication-journal.js`、`projection-store.js`。
- [ ] 新增测试严格保持 **5 个 top-level**：journal 文件 4 个（表驱动 fresh+同 logical retry、source incomplete、path/reparse/final occupied、binding/checksum/CAS）+ crash 文件 1 个（candidate durable、final absent、install 前重启）。不扩同义矩阵，非法输入只在 owner 测。
- [ ] 运行并提交：

```powershell
bun test --timeout 120000 server/tests/project-creation-journal.test.js server/tests/project-creation-crash.test.js
bun test --timeout 120000 server/tests/manuscript-store.test.js server/tests/manuscript-uid-reservation.test.js
$changedJs = @('server/manuscript/project-creation-journal.js', 'server/manuscript/project-creation-service.js', 'server/manuscript/route-store.js', 'server/manuscript/store.js', 'server/manuscript/uid-reservation.js', 'server/manuscript/uid-reservation-sources.js', 'server/native/durability-schema.js', 'server/native/native-project-store.js', 'server/tests/fixtures/project-creation-crash.js', 'server/tests/manuscript-uid-reservation.test.js', 'server/tests/project-creation-crash.test.js', 'server/tests/project-creation-journal.test.js')
$changedJs | ForEach-Object { node --check $_; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }
git diff --check
# 仅唯一 final review 通过后由 root 执行：
git add docs/superpowers/plans/2026-08-17-l2-file-authority.md server/manuscript/project-creation-journal.js server/manuscript/project-creation-service.js server/manuscript/route-store.js server/manuscript/store.js server/manuscript/uid-reservation.js server/manuscript/uid-reservation-sources.js server/native/durability-schema.js server/native/native-project-store.js server/tests/fixtures/project-creation-crash.js server/tests/manuscript-uid-reservation.test.js server/tests/project-creation-crash.test.js server/tests/project-creation-journal.test.js
git commit -m "feat: create file-authority projects recoverably"
```

---

## Task 14: 实现退役、重激活和数据根屏障

**Depends on:** Task 8A + Task 8B + Task 9C + Task 9D + Task 10A1 + Task 10A2 + Task 10B1 + Task 10B2 + Task 10B3 + Task 11A + Task 12 + Task 13。

**Files:**

- Create: `server/manuscript/retirement-service.js`
- Create: `server/manuscript/data-root-guard.js`
- Modify: `server/manuscript/session-controller.js`
- Create: `server/tests/manuscript-retirement.test.js`
- Create: `server/tests/manuscript-data-root-guard.test.js`

- [ ] Task 14 才首次为 Task 8B/9C `ManuscriptSessionController` 增加 retirement API：`beginRetiring(projectSelector)` 在 registry/config lease 内原子关闭该项目的新 `openSession()`/新 `admit()` 并返回只能由同 controller 消费的 opaque retirement epoch；`drain(retirementEpoch)` 只在释放 registry/config 与 writer lease 后等待该项目全部已 admission in-flight 归零。Task 8B/9C 不得预留 plain epoch、duck token 或提前实现 retirement API。
- [ ] files 项目进入旧物理删除接口时，在删除 DB/封面/目录之前返回 `PROJECT_PERMANENT_DELETE_UNSUPPORTED`；sqlite 项目保持旧删除行为。
- [ ] 退役锁序固定：registry/config 下 controller→retiring → 释放 lease → 无锁排空已 admission 请求 → 重取 registry/config 并复核 → writer → 拆 feed/关 session/放 shared → 非阻塞 exclusive → route/cache CAS。
- [ ] 确定性交错把请求停在 admission 后、registry/config 前与 writer 前，退役必须让已 admission 请求完成，不能持 registry/config/writer 等待它。
- [ ] 其他进程仍有 shared session 时 exclusive 返回 `PROJECT_WRITE_BUSY` 且 route/cache 零变化；失败后只能消费同一 opaque retirement epoch 恢复本进程 controller，重新复核 route/身份/generation 后才恢复 admission，不得用 caller boolean 或 plain token 解除 retiring。
- [ ] 重激活在 exclusive 下 CAS `retired→files`；首会话重新 shared/recheck/feed/full validation，不复用旧 clean、buffer、counter。
- [ ] retired 不进入普通列表/路由，不持 feed/shared handle；专用列表可重激活，所有资产原位保留。
- [ ] 只要存在 files/migrating/retired 或非终结 creation journal，数据根设置/迁移在创建目录或复制前返回 `NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED`。
- [ ] 创建、迁移、设置数据根三个入口检测 OneDrive/iCloud/reparse 并提供替代位置引导。
- [ ] 本任务只实现可注入的 retirement/data-root backend policy 与 lease 状态机，不修改 API、CLI、项目删除或 storage-migration 产品入口；这些入口在 Task 14B 一次性接线，避免在 Tasks 10A1、10A2、10B1–10B3 与 11–14 完成前暴露半套行为。
- [ ] 运行并提交：

```powershell
bun test --timeout 60000 server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js
git diff --check
git add server/manuscript/retirement-service.js server/manuscript/data-root-guard.js server/manuscript/session-controller.js server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js
git commit -m "feat: retire file-authority projects safely"
```

---

## Task 14B: 最终接线产品 API、CLI、读写入口与恢复动作

**Depends on:** Task 8A + Task 8B + Task 9C + Task 9D + Task 10A1 + Task 10A2 + Task 10B1 + Task 10B2 + Task 10B3 + Task 11A + Task 12 + Task 13 + Task 14。必选 backend/journal 合同完成后即可开始；这是 `files` route 首次可达真实 DraftConflictJournal service、ignored 出口、迁移、创建与退役行为的唯一接线点。Task 11B 的 client registry 不进入 server composition，由 Task 15 独立接入 host preflight。Task 10P 已固定 omitted，composition 只能 full-only。

> **2026-08-18 fast-core checkpoint（冻结 brief 范围）:** 已完成默认启动/关闭的 production runtime composition、schema 12 的真实 route/database/journal activated proof admission、`getProjectDb()` 前的产品 route 分派、server-owned 项目 metadata digest、读响应 base witness 与写前 witness 重验，以及真实 ProjectCreationService/MigrationService/L2 Store adapters。普通 `POST /projects` 永远保持 SQLite 默认；只有显式 files-Beta create/migrate 进入 L2，且不写 `recent_projects`。本 checkpoint 不宣称完成其余完整 Task 14B 矩阵：AI、CLI、export、stats、recent-projects 浏览、退役/数据根迁移、冲突 UI 与 GC/checkpoint 仍按计划后移或显式 unsupported。

**Files:**

- Modify: `server/routes/api.js`
- Modify: `server/tools.js`
- Modify: `server/project-export.js`
- Modify: `server/index.js`
- Modify: `server/cli.js`
- Modify: `server/ai-continue-save.js`
- Modify: `server/chapter-revisions.js`
- Modify: `src/lib/api.ts`
- Modify: `server/prompts/context.js`
- Modify: `server/db.js`
- Modify: `server/manuscript-service.js`
- Modify: `server/manuscript/l2-service.js`
- Create: `server/manuscript/draft-conflict-service.js`
- Modify: `server/manuscript/freshness.js`
- Modify: `server/manuscript/product-gates.js`
- Modify: `server/manuscript/uid-reservation-sources.js`
- Modify: `server/storage-migration.js`
- Modify: `server/recent-projects.js`
- Modify: `server/manuscript-sql-guard.js`
- Modify: `scripts/manuscript-write-scan.mjs`
- Modify: `scripts/tests/manuscript-write-scan.test.mjs`
- Create: `src/lib/manuscriptMigrationAdmission.ts`
- Modify: `server/tests/chapter-update-api.test.js`
- Modify: `server/tests/chapter-tools-identity.test.js`
- Modify: `server/tests/project-export.test.js`
- Modify: `server/tests/project-delete-api.test.js`
- Modify: `server/tests/storage-migration.test.js`
- Modify: `server/tests/cli.test.js`
- Modify: `server/tests/recent-projects.test.js`
- Create: `server/tests/manuscript-product-routing.test.js`
- Create: `server/tests/manuscript-recovery-api.test.js`
- Modify: `server/tests/manuscript-freshness.test.js`
- Modify: `server/tests/manuscript-product-gates.test.js`
- Create: `server/tests/draft-conflict-service.test.js`
- Create: `tests/manuscriptMigrationAdmission.test.ts`

**Product write-intent and freshness interfaces:**

```js
const productWriteIntents = {
  bindL2Command(command) {},
  bindOrphanAction(action, request) {},
  authority() {},
  execute(intent, turnContext) {},
};
// authority() 返回 stable frozen { assert(intent), describe(intent) }。
// describe() exact result:
// { family:'ordinary_create', logicalInputDigest:lowercase64Hex }
// | { family:'orphan_resolution'|'non_create', logicalInputDigest:null }

async function ensureProjectionCurrentForWrite(
  admission,
  writerTurn,
  { logicalRequestId, writeIntent },
) {}
// 第三个参数只允许 exact frozen own-data { logicalRequestId, writeIntent }，不是开放 options。

function createManuscriptProductGates({
  projectSessionAdmission,
  writerTurns,
  freshness,
  turnContextSource,
  policy,
  productWriteIntentAuthority,
}) {}
```

- [ ] 为正文、标题、大纲、状态、摘要、五个叙事字段、卷创建/改名/移动/重排/删除分别写 route/tool 失败测试，断言 `files` route 不执行文章真值 SQL 直写；REST、自动保存、AI 工具、续写和提案接受统一调用 Task 9D 写 turn。
- [ ] `server/manuscript-service.js` composition 内构造唯一私有 `productWriteIntents` broker，不导出 mint/WeakMap。`bindL2Command(command)` 先调用同一 production `l2Service.bindWriteIntent(command)`，再用其 original `writeIntentAuthority()` assert/describe，并在 broker-private WeakMap 记录 downstream original intent 与 exact descriptor。`bindOrphanAction(action, request)` 的 action 只允许 server-owned literal `ignore_in_place | revoke_ignore`，先调用 Task 10A2 `orphanResolutionService.snapshotRequest(request)` 取得其自身 frozen exact `{ kind, uid }` 快照，再记录 action+原 snapshot 与 descriptor `{ family:'orphan_resolution', logicalInputDigest:null }`；API body/caller 不能提供 action、family、digest、authority 或 prepared authority。journal logical-ID 分类仍把它视为 non-create，但 freshness 不得把它混回普通 `non_create` FULL 路径。
- [ ] `productWriteIntents.authority()` 是同一 broker 的 stable original frozen `{ assert, describe }`，只接受该 broker WeakMap 中的原 intent；plain/clone/foreign broker、L2 downstream intent、orphan frozen request 与任意伪 descriptor 全拒绝。`execute(intent, turnContext)` 只从私有记录分派：L2 精确调用 `l2Service.execute(originalIntent, turnContext)`，orphan 则以记录的 action+request 调用 `preflightResolution(action, frozenRequest, turnContext)`，再把返回的原 prepared authority 交给 `publishResolution(prepared, turnContext)`；两类都没有 raw command/action/request 第二输入，late API-body mutation 不能改变执行 bytes。L2 intent 冒充 orphan、orphan request/intent 冒充 L2、prepared clone/替换及两向 downstream swap 都在下游 adapter 前拒绝。
- [ ] route 选择 binder 完全 server-owned：ordinary L2 命令只走 `bindL2Command`，Task 10A2 两个 projection-only 动作分别以内部 literal 走 `bindOrphanAction`；所有其他产品写若未在 broker exact 表显式纳入，必须在 gate 前拒绝，不能绕过 broker直接调用领域 service。route 只把原 broker intent 放入 exact frozen `{ logicalRequestId, policyInput, writeIntent }`，领域 callback 只调用 `productWriteIntents.execute(sameOriginalIntent, turnContext)`；不得重新从 body 构造、二次 bind 或替换 intent。
- [ ] 普通 L2 写 turn 固定为 Task 8B/9C 长生命周期 session admission → writer lease → exact 三键 request 调用 `ensureProjectionCurrentForWrite()` → 真实 `turnContextSource` 捕获同 generation 上下文 → server-owned policy input + Task 11A journal policy → broker execute。Task 11B client registry 不传入 server policy。`orphan_resolution` 是唯一例外：仍先 admission/writer 与 ordinary-journal classify，但不 claim/settle dirty、也不跑 before-ledger ordinary FULL；改由 `turnContextSource.captureOrphanBaseline()` 只返回同一 Store、同 generation `B` 的 original baseline authority/context，policy ALLOWED 后 broker 才调用 Task 10A2 的唯一 preflight+projection action。领域 callback 前任一失败不得调用 L2/OrphanResolutionService 或创建 FilePublicationJournal；`sqlite` 继续走 L1，`migrating` 返回 `PROJECT_MIGRATION_BUSY`，`retired` 拒绝普通入口。
- [ ] `product-gates.js` 将 Task 9D 基线 request 有意升级为 exact frozen `{ logicalRequestId, policyInput, writeIntent }`，构造器新增且只接受 `productWriteIntents.authority()` 的 original frozen capability。它必须在任何 admission/writer/freshness 副作用前 `assert(writeIntent)`，再把同一 broker intent 原引用交给 freshness；plain/clone/foreign broker intent 或 extra/accessor 立即拒绝。freshness 与其 constructor-bound `journalRecovery` 注入同一个 broker capability，并在任何 journal/FULL 操作前再次 assert/describe；caller 不能传 family/digest、preserve/recovery mode、journal ID 或其他选项。
- [ ] `ensureProjectionCurrentForWrite()` 先取得 exact `{ family, logicalInputDigest }` 并用 Task 10B2 parser 分类 logical request。ordinary create/non-create 保持既有 preserve/recover/replay 与同一个 FULL 序列；create digest 不同，或 non-create/orphan intent 撞已有 ordinary-create chain，均在 recovery/FULL/callback 前 `RECOVERY_REQUIRED`。无链 `orphan_resolution` 返回 module-private baseline admission给 `captureOrphanBaseline()`，不得调用 ordinary FULL；其他 logical IDs 仍 generic recover。两条分支都不复制第二套 journal parser/freshness状态机。
- [ ] 三个 product focused tests 锁定：dirty new UID 与 revoked-reappeared 都 ordinary FULL=0、resolution scan=1，成功后 active-ledger ordinary FULL green；第二 unknown、policy deny、plain/clone/stale baseline、intent swap 均 projection/FileJournal/file write=0；matching early create+同 ID orphan、异 create digest、错误 logical ID/duplicate journal/recovery/FULL失败仍在任何领域副作用前拒绝。另保留 ordinary exact matching early → FULL → capture → policy → replay。这才闭合 Task 10B3 cold retry 与 Task10A2产品可达性。
- [ ] 同一 composition root 首次构造 Task 9D 的真实 session/context 与 Task 11A policy：普通 context source 自持 production CSPRNG/clock并一次捕获六键上下文；orphan baseline source只铸同 Store/same B original authority，不接受 caller snapshot/rows。缺项、stale、foreign或 logical ID不回显均在 policy/callback/journal前拒绝；禁止每请求二次全树扫描或从错误 details 补 observation。
- [ ] 产品 composition root 构造 Task 8B/9C 的真实 controller依赖并固定 full-only：不创建、不注入、不探测 self-event/incremental ports。`manuscript-product-routing.test.js` 必须断言 ordinary dirty 始终 FULL、Task10P无模块/接线。`notificationCapability` 仍只从 build-info authority读取，Task17B前production fallback=false；任一依赖错配在锁/feed/枚举/query/journal前拒绝。本任务不修改build-info，最终true只留Task17B。
- [ ] composition 首次修改 `server/db.js`：只有真实 MigrationJournal/ProjectCreationJournal 持久 `activated` proof、v2 inspector 与 route binding 同时匹配时才把 `PROJECT_SCHEMA_VERSION` 提升到 12 并接纳 schema12；schema11 原 native activation admission 保持不变，schema13+ 与无 proof 的 schema12 在打开/写入前零修改拒绝。
- [ ] 同一 composition root 必须调用 Task 6 零注入 `createProductionManuscriptFileBoundary()`，先用 production pair validator 重验原始 frozen pair、production mode 与共同 backend token，再只把 read cap 交给 ManuscriptStore、只把 writer cap 交给 FilePublisher；不得接受 caller pair/cap、plain clone、test mint、foreign backend 拼接或 read/writer swap。`manuscript-product-routing.test.js` 必须证明以上替换在任何目录枚举、asset 创建或 journal 事件前拒绝。
- [ ] 同一 composition root 首次把 Task 10B2 ordinary FilePublicationJournal、Task 12 registry/existing-root/MigrationJournal、Task 13 ProjectCreationJournal 的全部真实 reservation sources，与 production CSPRNG、Store name-index path probe 组成无缺项 catalog 后注入 Task 10B3 ordinary create；任一 source 缺失/枚举不完整或 probe 非 production brand 都在抽号、journal 与文章副作用前 fail-closed，禁止默认空 catalog。
- [ ] 列表、详情、导出、统计、角色关联、AI 上下文和只读工具统一走 Task 9D readable wrapper + ActiveManuscriptProjection；消除产品路径 tombstone、旧 generation 和 `MAX(num)` 读取。
- [ ] `server/prompts/context.js` 不再直接打开项目数据库或用 broad catch 把 admission/freshness/route 错误降级成 `项目: <name>`；它通过同一 readable wrapper + ActiveManuscriptProjection 取得 active metadata context，admission 错误必须原样抛出并中止本次 AI 调用。该覆盖写入既有 `server/tests/manuscript-product-routing.test.js`，不新增无对应实现边界的 prompt 测试文件。
- [ ] `recent-projects.js` 只消费 Task 12 的 route cache；缓存缺失、损坏、缺项或陈旧时调用同一 `rebuildConfigCache()` 从项目数据库真值重建，不能从 config/caller 值反写项目 route。产品 progress/overdue 只使用活跃行的 `manuscript_position`，并以 `currentMax(manuscript_position) >= expected_resolve_manuscript_position` 判定 overdue；不得读取 `MAX(num)` 或旧 `expected_resolve_chapter`。
- [ ] API 完整接线 Task 10A2 的 projection-only `ignoreInPlace`/`revokeIgnore` 与 Task 10B1 的 `ignored.preserve_move_to_unassigned`/`ignored.detach_reference`；前两个 endpoint 只接受 Task 10A2 规范 `{ kind, uid }` request，并由 route 选择 server-owned orphan action literal，API body 不接受 action；后两个结构请求只接受规范 UID/动作枚举。四者都不接受路径并返回 generation/ledger 状态；前两个不触碰受控文件，后两个只发布 Task 10B1 的 exact 索引闭包，API 集成测试逐字节证明四条路径都不移动或删除对应 opaque 资源文件 bytes。
- [ ] API/CLI 调用 Task 12 同一个 MigrationService；项目创建调用 Task 13 ProjectCreationService；旧物理删除、退役/重激活和数据根入口调用 Task 14 policy。不得在 route/CLI 内复制 journal 状态机、UID reservation、目录创建或锁文件创建逻辑。
- [ ] 建立 host-only migration admission seam `beginMigrationAfterHostPreflight(frozenSnapshot, request)`：只接受同一 project/window set 的不可变 snapshot 且每个 dirty resource 均为 `persisted | explicitly_resolved`、全部 save queue 已 `cancelled_and_drained`、所有窗口均已响应；否则在调用 migration API 之前 fail-closed。服务端 route 明确不能独立验证 host dirty registry，也不得把“收到 API 请求”误写成 host preflight 证明；它只在 host seam 真正发起请求后调用 Task 12 service。
- [ ] call-order integration test 用可观察 fake host admission、真实 route/MigrationService fixture 与目录字节快照证明：freeze 未完成、任一 dirty resource 未解决、save queue 未 drain、snapshot/window set 改变或任一窗口无响应时，migration API/MigrationService 调用次数为 0，`migration_reserved`、route/project DB、ControlStore 和全部目标路径 bytes/存在性逐字节不变；只有完整 resolved snapshot 可恰好调用一次。Task 15 的 coordinator 必须调用这一 seam，不得直接调用 route。
- [ ] 新建 `DraftConflictService`，在同一 admitted writer turn 把 Task 11A opaque intents/evidence 与 Task 12 projection CAS、Task 6 parent=`draft_conflict` child publication组合起来；不得在 service 复制 L2 build/stage/target编排。API 接线 Task 11A 冲突列表、backup复制、`accept_external`、`apply_saved_draft`与stale/epoch结果；只有 `backup_durable` 后可声明backup可用，迟到epoch永久拒绝。Task11A只记录的retention debt在这里用production storage authority实现crash-safe删除；未证明无引用则保留。
- [ ] 将 `src/lib/api.ts` 的 `ChapterRevision.status` 精确扩展为包含 literal `stale`，并让提案列表、接受/拒绝入口与客户端状态处理明确把 `stale` 视为不可继续处理的历史语义状态，绝不能把它回退、别名化或筛选成 `pending`；现有 `pending | accepted | rejected | superseded` 语义保持不变。
- [ ] 在本任务第一次建立完整静态扫描 RED：文章真值 SQL/受控文件直写、caller-supplied controlled path、跳过 freshness 的活跃读取、tombstone 读取、章节/卷物理 DELETE、`MAX(num)` 分配/overdue 与 `expected_resolve_chapter` 旧语义逐类使用最小 fixture 失败；随后把全部产品文件纳入同一扫描，删除 API/tools 六条物理 DELETE 并消除其余旧语义，最终扫描必须零债务。全程不建立临时、逐项、目录级或整文件 allowlist；只有持有精确内部 capability 的 schema/projection/recovery 语句由结构化 owner 规则排除。
- [ ] 两进程与请求乱序测试证明 session/writer/freshness/conflict 的释放顺序稳定，失败、取消和 stale response 不清 dirty/conflict evidence；migration/creation/retirement 尚未终结时产品入口 fail-closed。
- [ ] 运行并提交：

```powershell
bun test --timeout 120000 server/tests/draft-conflict-service.test.js server/tests/manuscript-product-routing.test.js server/tests/manuscript-recovery-api.test.js server/tests/manuscript-freshness.test.js server/tests/manuscript-product-gates.test.js server/tests/chapter-update-api.test.js server/tests/chapter-tools-identity.test.js server/tests/project-export.test.js server/tests/project-delete-api.test.js server/tests/storage-migration.test.js server/tests/cli.test.js server/tests/recent-projects.test.js
node --test --test-concurrency=1 tests/manuscriptMigrationAdmission.test.ts
node --test scripts/tests/manuscript-write-scan.test.mjs
git diff --check
git add server/routes/api.js server/tools.js server/project-export.js server/index.js server/cli.js server/ai-continue-save.js server/chapter-revisions.js src/lib/api.ts server/prompts/context.js server/db.js server/manuscript-service.js server/manuscript/l2-service.js server/manuscript/draft-conflict-service.js server/manuscript/freshness.js server/manuscript/product-gates.js server/manuscript/uid-reservation-sources.js server/storage-migration.js server/recent-projects.js server/manuscript-sql-guard.js scripts/manuscript-write-scan.mjs scripts/tests/manuscript-write-scan.test.mjs src/lib/manuscriptMigrationAdmission.ts server/tests/chapter-update-api.test.js server/tests/chapter-tools-identity.test.js server/tests/project-export.test.js server/tests/project-delete-api.test.js server/tests/storage-migration.test.js server/tests/cli.test.js server/tests/recent-projects.test.js server/tests/draft-conflict-service.test.js server/tests/manuscript-product-routing.test.js server/tests/manuscript-recovery-api.test.js server/tests/manuscript-freshness.test.js server/tests/manuscript-product-gates.test.js tests/manuscriptMigrationAdmission.test.ts
git commit -m "refactor: route manuscript products through complete L2 gates"
```

---

## Task 15: 交付恢复 UI、容量/降级状态与宿主文件入口

**Depends on:** Task 14B + Task 11B。Task 11B 只在此处首次接入真实 editor/save-queue/window producers。

**2026-08-20 files Beta 范围覆盖（本提交随代码落地）：** 本轮只交付显式 SQLite→files Beta 确认入口、正文/标题队列到 dirty registry 的接线，以及外部冲突/`RECOVERY_REQUIRED` 时保留本地草稿并把编辑器切为只读。迁移前只检查当前进程的正文与标题队列，任一未保存草稿都会在 API 调用前阻断；普通新建和 SQLite 默认路由不变。下面原计划中的多窗口冻结协调器、逐资源解决向导、容量/诊断包、open/reveal 宿主命令、orphan/退役 UI、Rust smoke 和完整 desktop matrix 全部后移到正式发布计划，不属于 Beta 完成条件。Beta 最终只再执行一次 focused E2E、TypeScript 检查与 desktop build；本任务冻结前不跑 full/VM。

**Files:**

- Create: `src/lib/manuscriptRoute.ts`
- Create: `src/lib/manuscriptMigrationPreflight.ts`
- Create: `src/lib/manuscriptMigrationPreflightSmoke.ts`
- Modify: `src/lib/dirtyResourceRegistry.ts`
- Create: `src/lib/manuscriptConflicts.ts`
- Modify: `src/lib/editorSaveQueue.ts`
- Modify: `src/lib/titleSaveQueue.ts`
- Modify: `src/components/EditorContent.tsx`
- Create: `src/components/ManuscriptStatusBanner.tsx`
- Create: `src/components/ManuscriptMigrationDialog.tsx`
- Create: `src/components/DraftConflictDialog.tsx`
- Create: `src/components/OrphanResourceDialog.tsx`
- Create: `src/components/RetiredProjectsDialog.tsx`
- Modify: `src/pages/ProjectList.tsx`
- Modify: `src/pages/Outline.tsx`
- Modify: `src/pages/Writing.tsx`
- Modify: `src/pages/ExportPage.tsx`
- Modify: `src/stores/useEditorStore.ts`
- Modify: `src/stores/useChapterStore.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/i18n/zh.json`
- Modify: `src/i18n/en.json`
- Create: `src-tauri/src/manuscript_files.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/manuscript_files_integration.rs`
- Create: `scripts/tests/desktop-manuscript-files-smoke.ps1`
- Create: `scripts/tests/desktop-manuscript-migration-preflight-smoke.ps1`
- Create: `tests/manuscriptRoute.test.ts`
- Create: `tests/manuscriptRecoveryUi.test.ts`
- Create: `tests/manuscriptMarkdownReadonly.test.ts`
- Create: `tests/manuscriptMigrationPreflight.test.ts`
- Create: `tests/manuscriptConflicts.test.ts`
- Modify: `tests/editorSaveQueue.test.ts`
- Modify: `tests/titleSaveQueue.test.ts`

**Host migration preflight:**

```ts
class HostMigrationPreflightCoordinator {
  freezeAllDirtyDomains(projectId: string): FrozenMigrationPreflightSnapshot;
  cancelAndDrainSaveQueues(snapshot: FrozenMigrationPreflightSnapshot): Promise<DrainedMigrationPreflightSnapshot>;
  recordDraftResolution(snapshotId: string, resource: DirtyResourceKey, disposition: "persisted" | "explicitly_resolved"): void;
  canConfirm(snapshotId: string): boolean;
  confirmAndBeginMigration(snapshotId: string, request: MigrationRequest): Promise<MigrationResult>;
}
```

**Host commands:**

```rust
#[tauri::command]
fn reveal_manuscript_file(project_uid: String, chapter_uid: String) -> Result<(), String>;

#[tauri::command]
fn open_manuscript_file(project_uid: String, chapter_uid: String) -> Result<(), String>;
```

- [ ] UI 明确区分 sqlite“删除”和 files“退役”；提供 retired 专用列表、重激活、升级延期、迁移进度、安全中止/恢复与诊断导出。
- [ ] 实现显式 host migration-preflight coordinator，并让“立即升级”成为它的唯一入口。coordinator 在显示/启用最终确认前冻结 Task 11B registry 接入后的全部 dirty 域（已加载/已卸载正文、sidecar、卷 metadata、结构队列）以及精确 multi-window ID/revision snapshot，阻止新 save admission，取消或排空每个 debounce/unloaded/window save queue，并要求每份 draft 已耐久保存或由用户逐项显式解决。任何资源/window/queue revision 在冻结后变化都使 snapshot stale，必须重新开始；不得把 host-only registry 交给 server 猜测。
- [ ] 只有 frozen window set 全部响应、所有 queue 均 `cancelled_and_drained`、每个 dirty resource 都有 `persisted | explicitly_resolved` disposition 时 `canConfirm()` 才为 true；`confirmAndBeginMigration()` 必须调用 Task 14B 的 `beginMigrationAfterHostPreflight` seam，项目页面和对话框不得直接调用 migration route。用户选择“稍后升级”或取消 preflight 时释放 freeze 且 API 零调用。
- [ ] host integration 负向测试分别保留一个未解决正文/sidecar/卷 metadata/structure/unloaded queue、多窗口迟到 dirty 和 non-responsive window；每次都断言确认按钮禁用、admission seam 与 migration API 零调用，并对真实 route fixture 的 `migration_reserved`、route/project DB、ControlStore、目标文章根和 sibling lifecycle lock 做 before/after bytes/存在性比较，全部不变。另测 drain/resolve 完整后恰好调用一次，以及 API 失败不会把旧 snapshot 当成可重试授权。
- [ ] 增加 `desktop-manuscript-migration-preflight-smoke.ps1`，它只接受绝对 `DesktopPath`、`SidecarPath` 和事先不存在的绝对 `ResultPath`，由脚本内部生成每 run 256-bit nonce，并在 ResultPath 的同一 run-owned 父目录以 `.<result-base>.<run-id>.request.json` 推导事先不存在的 create-new request file（调用方不能传 request path）。脚本启动 fresh debug `mythpen.exe`，只在继承环境中传递 nonce、在 argv 只传 request path；必须等待 desktop/sidecar 退出并要求 result create-new。Rust/Tauri 只在 `debug_assertions` 下注册一次性 authenticated preflight-smoke bootstrap：验证 request 实名/普通文件身份/owner、nonce SHA-256 与 run ID 后只允许执行固定 matrix，消费一次即失效；production build 不编译/注册该 bootstrap，认证失败、重复使用、任意自定义 case/route/path 都在调用 coordinator/API 前拒绝。
- [ ] compiled desktop bootstrap 必须通过实际打包的 `HostMigrationPreflightCoordinator → beginMigrationAfterHostPreflight → route/MigrationService` 链运行固定 matrix：未解决 body、sidecar、volume metadata、structure、unloaded queue、stale multi-window epoch、non-responsive window 七个负例，以及全部 persisted/explicitly-resolved 的一个正例。负例逐项记录 API/service call count=0 及 reservation/route/project DB/ControlStore/article root/lifecycle lock before/after hash/存在性相等；正例记录 API/service 恰好一次和绑定的 migration ID。测试 adapter 只注入 window/save-queue 响应与 fixture 路径，不得替换 coordinator、admission seam 或 route。
- [ ] smoke result 固定为 UTF-8 canonical JSON、`version=1` / `type="mythpen.desktop-l2-migration-preflight-smoke.v1"` / `status="PASS"`，包含 source commit、target triple、debug desktop path/bytes/SHA-256、sidecar path/bytes/SHA-256、`auth.mode="debug-only-one-time-nonce-v1"`、run ID、`request.path|bytes|sha256`、`suite.total|passed|failed` 与固定 `cases[].id|status|apiCalls|serviceCalls|beforeDigest|afterDigest`；不得包含 nonce 或稿件正文。脚本只在 8/8、failed=0、所有绑定复核成功后返回 0；任一失败保留 request/raw/result 现场并返回非零，不得伪造 PASS。
- [ ] 持续展示 direct-feed 降级/陈旧窗口、非受控残留提示、80% 容量预警、启动完全校验进度；显式刷新可取消且不阻塞 UI 主线程。
- [ ] 错误码映射为可操作说明：外部冲突、格式过新、路径不安全、超限、目标占用、迁移忙、recovery required；不可收敛项目隔离为只读现场。
- [ ] 孤儿/外部 UID 对话框展示并调用四个完整出口：就地忽略、撤销忽略、保留并转为未分卷、解除不透明引用；明确说明相对位置规则、容器删除阻断与“不会移动/删除资源文件”，成功后按返回 generation 刷新。UI tests 覆盖四动作、取消、stale 与 revoke 后重新阻断。
- [ ] 编辑器消费 Task 3 Markdown 分类：精确可视方言保持可编辑；合法但方言外 UTF-8 与 U+0000 显示持续只读状态，仍可查看/复制/导出并编辑元数据，自动保存正文、AI 续写和提案应用按钮被禁用且服务端拒绝仍可见；不得把只读正文重新序列化。
- [ ] 诊断包只含相对标识、身份、大小、hash、journal、能力、残留分类和容量统计，不含正文、标题、大纲或 sidecar 文本。
- [ ] 章节“在文件管理器中显示/用默认应用打开”只接受 project/chapter UID；Rust 端重新从可信数据根/route 解析规范路径并复核身份，不接受前端绝对路径。
- [ ] 把可信路径解析与 host launcher 做成命令和测试共用的 Rust 边界；Rust integration test 覆盖真实/别名/reparse/hard-link/错误 route/未知 UID。debug desktop 仅在 `debug_assertions` 下提供一次性 authenticated host-smoke 启动模式，由专用 PowerShell 脚本驱动编译后的 `mythpen.exe` 依次经过同一 command handler 执行 reveal/open，并用注入 launcher 记录目标而不实际弹出外部应用；production build 不包含该入口。
- [ ] 未分卷章节在侧栏、编辑、导出、删除和文件入口中与已分卷章节等价。
- [ ] 运行并提交：

```powershell
node --test --test-concurrency=1 tests/manuscriptRoute.test.ts tests/manuscriptRecoveryUi.test.ts tests/manuscriptConflicts.test.ts tests/manuscriptMarkdownReadonly.test.ts tests/manuscriptMigrationPreflight.test.ts tests/editorSaveQueue.test.ts tests/titleSaveQueue.test.ts
pnpm typecheck
pnpm exec biome check src/
cargo test --manifest-path src-tauri/Cargo.toml --test manuscript_files_integration
pnpm build:sidecar
pnpm tauri build --debug
$hostSmokeResult = Join-Path ([System.IO.Path]::GetTempPath()) "mythpen-manuscript-files-smoke-$([guid]::NewGuid()).json"
powershell.exe -NoProfile -File .\scripts\tests\desktop-manuscript-files-smoke.ps1 -DesktopPath .\src-tauri\target\debug\mythpen.exe -SidecarPath .\src-tauri\binaries\mythpen-server-x86_64-pc-windows-msvc.exe -ResultPath $hostSmokeResult
$preflightDesktopPath = (Resolve-Path -LiteralPath '.\src-tauri\target\debug\mythpen.exe').Path
$preflightSidecarPath = (Resolve-Path -LiteralPath '.\src-tauri\binaries\mythpen-server-x86_64-pc-windows-msvc.exe').Path
$preflightSmokeResult = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) "mythpen-manuscript-migration-preflight-smoke-$([guid]::NewGuid()).json"))
if (-not [System.IO.Path]::IsPathFullyQualified($preflightSmokeResult) -or (Test-Path -LiteralPath $preflightSmokeResult)) { throw "Preflight smoke ResultPath must be absolute and create-new: $preflightSmokeResult" }
powershell.exe -NoProfile -File .\scripts\tests\desktop-manuscript-migration-preflight-smoke.ps1 -DesktopPath $preflightDesktopPath -SidecarPath $preflightSidecarPath -ResultPath $preflightSmokeResult
git diff --check
git add src/lib/manuscriptRoute.ts src/lib/manuscriptMigrationPreflight.ts src/lib/manuscriptMigrationPreflightSmoke.ts src/lib/dirtyResourceRegistry.ts src/lib/manuscriptConflicts.ts src/lib/editorSaveQueue.ts src/lib/titleSaveQueue.ts src/components/EditorContent.tsx src/components/ManuscriptStatusBanner.tsx src/components/ManuscriptMigrationDialog.tsx src/components/DraftConflictDialog.tsx src/components/OrphanResourceDialog.tsx src/components/RetiredProjectsDialog.tsx src/pages/ProjectList.tsx src/pages/Outline.tsx src/pages/Writing.tsx src/pages/ExportPage.tsx src/stores/useEditorStore.ts src/stores/useChapterStore.ts src/stores/useProjectStore.ts src/i18n/zh.json src/i18n/en.json src-tauri/src/manuscript_files.rs src-tauri/src/lib.rs src-tauri/tests/manuscript_files_integration.rs scripts/tests/desktop-manuscript-files-smoke.ps1 scripts/tests/desktop-manuscript-migration-preflight-smoke.ps1 tests/manuscriptRoute.test.ts tests/manuscriptRecoveryUi.test.ts tests/manuscriptConflicts.test.ts tests/manuscriptMarkdownReadonly.test.ts tests/manuscriptMigrationPreflight.test.ts tests/editorSaveQueue.test.ts tests/titleSaveQueue.test.ts
git commit -m "feat: expose file-authority recovery workflows"
```

---

## Task 16: 完成本地正确性 join 与最终验收 harness

**Depends on (explicit join):** Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7A + Task 7B + Task 8A + Task 8B + Task 9A + Task 9B + Task 9C + Task 9D + Task 10A1 + Task 10A2 + Task 10B1 + Task 10B2 + Task 10B3 + Task 11A + Task 11B + Task 12 + Task 13 + Task 14 + Task 14B + Task 15。这里只做 source/local join；不冻结 production source，不运行 VM，不发布 manifest/candidate/result/attestation；Task 10P 不在 join 中。

**Files:**

- Create: `server/tests/l2-correctness-matrix.test.js`
- Create: `server/tests/l2-two-process-matrix.test.js`
- Create: `server/tests/l2-capacity-boundary.test.js`
- Create: `server/tests/l2-performance-benchmark.test.js`
- Create: `server/tests/fixtures/create-l2-benchmark-project.js`

- [ ] 汇总规范 15.1–15.7 为逐行可追踪矩阵，记录 test ID、命令、产物、退出码和结论，不使用“同类情况已覆盖”。格式/安全矩阵覆盖 case alias、reparse、hard link、未知文件、journal candidate、孤儿、外部 UID 四出口、容量边界/超限和外部连续改写；ignored 矩阵锁定 Task 10A1 canonical member snapshot、`manuscript` container 与 Task 3 observation → Task 5 rows compiler，并另锁定 Task 10B1 known+opaque index serializer，再分别覆盖 Task 10A2 projection-only ignore/revoke 和 Task 10B1 preserve/detach。Markdown 专项覆盖精确可视方言每一构造、合法 out-of-dialect UTF-8 只读透传、元数据写仍成功、自动保存/AI/提案等语义正文写拒绝、U+0000 投影 content 置空但 raw hash/word count/generation 正确，以及 Task 15 UI 只读状态。
- [ ] DDL/投影矩阵覆盖 ID/sequence 保留、tombstone/复活、真实两阶段 position/活跃编号更新、部分唯一索引、章节 `data_version` 每次逻辑 projection 最多 `+1`、`chapter_revisions` literal `stale` CHECK 与 rows/ID/sequence/index 保留、proposal invalidation 原子性、物理 DELETE barrier、overdue、schema/digest 三方检查和 schema too new 零修改；同时锁定 schema 11 的 revision CHECK、data-version trigger 与 v1 digest 逐字节不变。普通 publication、draft conflict、migration、creation 的每个指定阶段前后都做强杀并核对完整 before/after。Task 15 已用 focused `desktop-manuscript-migration-preflight-smoke.ps1` 经过真实 compiled debug coordinator/admission/route 链验证固定 7 负 + 1 正 matrix；Task 16 只把同一 case ID/result schema 锁进本地 correctness harness，不重复构建或运行 desktop。最终 source 的 fresh compiled/production smoke 只在 Task 17B 再运行一次，source-only client test 不能替代它。
- [ ] 两进程矩阵运行 writer/refresh/session/retire 竞争，验证 lease 顺序、false-clean 不变量、强杀释放与 admission 后 route/identity 复核。容量矩阵用 10,000 章节身份、2,000 卷身份、25,000 文件、20,000 chapter dir entries、16 MiB md、256 KiB json、1 GiB 累计边界 fixture，并读取 Task 3 observer/counter seam，逐维证明第一次超限后枚举数、身份 probe 数和内容打开数不再增长；超限现场不读全树、不清 dirty、不改外部字节。
- [ ] freshness join 只证明 Task 9C 把 ordinary dirty 全部交 FULL、原 `claimSnapshot` 只 settle 一次且新 dirty 保留；不得在本任务补实现、补接线或声称存在 incremental，性能结论保持 `PERFORMANCE_DEFERRED`。
- [ ] 冻结两个不可缩小的**本地** fixture（3,000 章/30–40 MiB 与 10,000 章/1 GiB），记录 seed、文件数、字节数和 manifest hash；Task 16 只验证 fixture/harness 的确定性、容量短路和 correctness case 集，不构建或接纳 production artifact。
- [ ] 在源码态跑一次本地 join；全部通过后只提交 correctness/performance harness 与 fixture。此提交不是 production evidence source freeze：

```powershell
bun test --timeout 600000 server/tests/l2-correctness-matrix.test.js server/tests/l2-two-process-matrix.test.js server/tests/l2-capacity-boundary.test.js server/tests/l2-performance-benchmark.test.js
git diff --check
git add server/tests/l2-correctness-matrix.test.js server/tests/l2-two-process-matrix.test.js server/tests/l2-capacity-boundary.test.js server/tests/l2-performance-benchmark.test.js server/tests/fixtures/create-l2-benchmark-project.js
git commit -m "test: join L2 local correctness"
git status --short
```

**Stop condition:** 任一本地 correctness、容量、两进程或 benchmark-harness focused case 失败时停止并修复；发现任何 incremental 模块/port/product接线也立即停止并删除，禁止回填Task10P。不得把 Task 16 的源码态/fixture 结果称为 production evidence，也不得在本任务运行完整源码回归、desktop build/smoke、13/19 VM 矩阵或构建 production candidate。

---

## Task 17A: 做最小性能 preflight 并决定默认路由

**Depends on:** Task 16；Task 10P 已 omitted 且不属于输入。

**Files:**

- Create: `docs/superpowers/plans/l2-performance-preflight.md`

- [ ] 使用 Task 16 已冻结的 3,000 章与 10,000 章/1 GiB fixture，在本机编译 sidecar/debug desktop 上做开发期 preflight；测量章节列表/侧栏、自动保存 E2E，以及启动完全校验和显式完全刷新。只记录 full-only ordinary-dirty 成本，incremental 门禁固定 `NOT_RUN / PERFORMANCE_DEFERRED`，不得把 FULL 样本改名为 incremental。记录全部样本、nearest-rank p50/p95/max、CPU/磁盘、冷/热缓存和安全软件状态；不生成 production manifest/candidate/attestation，也不把结果称为最终验收。
- [ ] 默认路由的 go/no-go 仍使用三项既定目标：列表/侧栏 p95 `<150 ms`、自动保存 E2E p95 `<300 ms`、L2 文件侧增量 p95 `<120 ms`；启动完全校验与显式刷新还必须在两个 fixture 上完成校准，且 UI 线程外执行、有可见进度、刷新可取消。任何一项无把握时选择 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，继续 sqlite 默认；不得缩小 fixture、降低样本数、删慢样本或放宽阈值。
- [ ] preflight 命令只消费源码态/本地编译产物：

```powershell
pnpm build:sidecar
bun test --timeout 600000 server/tests/l2-performance-benchmark.test.js
```

- [ ] 只把 preflight 数字、运行条件和默认路由决定写入文档；任一性能门禁未通过时只记录 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED` 并保持 sqlite 默认，不得回头实施、修复或接线 Task 10P。未来若证据要求增量刷新，必须另立计划并重开 composition root 与产品路由测试。所有 production source 和默认路由决定稳定后才进入 Task 17B：

```powershell
git diff --check
git add docs/superpowers/plans/l2-performance-preflight.md
git commit -m "docs: record L2 performance preflight"
```

---

## Task 17B: 冻结 capability build-info、按门禁切换默认路由并验收最终 production artifact

**Depends on:** Task 17A；Task 10P 已 omitted，不属于最终 source。

**Files:**

- Modify: `server/build-info.js`
- Modify: `server/sidecar-control.js`
- Modify: `server/tests/sidecar-control.test.js`
- Modify: `scripts/build-sidecars.mjs`
- Modify: `scripts/tests/build-sidecars.test.mjs`
- Modify: `src-tauri/src/sidecar_protocol.rs`
- Modify: `src/lib/backendRuntime.ts`
- Modify: `tests/backendRuntime.test.ts`
- Modify: `tests/apiNonceTransport.test.ts`
- Modify: `server/manuscript/project-creation-service.js`
- Modify: `src/pages/ProjectList.tsx`
- Modify: `server/tests/project-creation-journal.test.js`
- Modify: `tests/manuscriptRoute.test.ts`
- Create: `server/tests/native-durability-benchmark.test.js`
- Create: `scripts/tests/l2-production-e2e.test.mjs`
- Modify: `scripts/tests/l1-production-e2e.test.mjs`
- Create after artifact validation: `docs/superpowers/plans/l2-production-candidate-acceptance.md`
- Create after artifact validation: `docs/superpowers/plans/l2-performance-evidence.md`
- Modify after artifact validation: `docs/superpowers/specs/2026-08-15-l2-file-authority-spec.md`

- [ ] 无论最终决定是 `DEFAULT_READY` 还是 `PERFORMANCE_DEFERRED`，都先实现并提交三份 final acceptance harness source。开发期只运行各文件中不构建 candidate、不执行 benchmark/compiled E2E 的 `production acceptance harness source contract` focused case，锁定 required case IDs、输入 fail-closed、final-source/manifest binding 与结果 schema；完整执行留到 final source 冻结后：

```powershell
bun test --test-name-pattern "production acceptance harness source contract" server/tests/native-durability-benchmark.test.js
node --test --test-name-pattern "production acceptance harness source contract" scripts/tests/l1-production-e2e.test.mjs scripts/tests/l2-production-e2e.test.mjs
git diff --check
git add server/tests/native-durability-benchmark.test.js scripts/tests/l1-production-e2e.test.mjs scripts/tests/l2-production-e2e.test.mjs
git commit -m "test: freeze L2 production acceptance harness"
```

- [ ] 不论 Task 17A 结果是 `DEFAULT_READY` 还是 `PERFORMANCE_DEFERRED`，都必须无条件完成 capability source checkpoint：`server/build-info.js` 以 exact frozen booleans 增加 `manuscriptLifecycleLease | manuscriptChangeNotification`，未编译/非 production fallback 保持 false；production build arguments 才把两个 compile-time define 固定为 true。JS `ready` / `build.info` validator、Rust `sidecar_protocol.rs` exact-key parser/handshake/`SidecarBuildInfo`、renderer `backendRuntime.ts` session validator/types 与 `smokeCompiledServer()` 必须逐项携带、比较这两个 boolean，拒绝缺键、额外键、非 boolean、ready/build.info 不一致或非 production 误广告；Tauri IPC 发布的 session 不能丢弃或弱化这两个字段。该 checkpoint 只跑四个 source-contract focused cases，不构建 candidate、不跑 benchmark/compiled E2E/VM：

```powershell
bun test --test-name-pattern "manuscript capability build-info source contract" server/tests/sidecar-control.test.js
node --test --test-name-pattern "manuscript capability build-info source contract" scripts/tests/build-sidecars.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml sidecar_protocol::tests::manuscript_capability_build_info_source_contract
node --test --test-concurrency=1 --test-name-pattern "manuscript capability build-info source contract" tests/backendRuntime.test.ts tests/apiNonceTransport.test.ts
git diff --check
git add server/build-info.js server/sidecar-control.js server/tests/sidecar-control.test.js scripts/build-sidecars.mjs scripts/tests/build-sidecars.test.mjs src-tauri/src/sidecar_protocol.rs src/lib/backendRuntime.ts tests/backendRuntime.test.ts tests/apiNonceTransport.test.ts
git commit -m "feat: bind manuscript native capabilities to build info"
```

- [ ] Task 17B 是全文唯一允许为最终 compiled candidate 增加/广告 `manuscriptLifecycleLease` 与 `manuscriptChangeNotification` capability 的任务。上述 source checkpoint 只冻结生产编译合同；Task 9C `notificationCapability` 在此之前的 production fallback 必须读为 false，只有绑定同一 final source/build-info/candidate 的 production define 才可读 true。后续 compiled L2 E2E 必须验证真实 Task 8A/9A–9C self-test 与 port 值一致才可接受；Task 8A、9A–9D、14B、16 的 local/source 结果都不能把 production capability 记为 true或代替 compiled 验收。

- [ ] 只有 Task 17A 全部性能门禁通过，才将 production 状态设为 `DEFAULT_READY`，让普通新项目默认创建 files，并向 sqlite 项目显示默认迁移入口；显式回退开关只选择新建路由，不建立双写或 migrated 项目的 sqlite-authoritative 回退。
- [ ] 先以两个直接相关的 focused source tests 固定 default route、explicit sqlite opt-out、迁移延期和无双写语义，并提交唯一的默认路由产品代码 checkpoint；本步骤不跑完整回归、build 或 VM：

```powershell
bun test server/tests/project-creation-journal.test.js
node --test --test-concurrency=1 tests/manuscriptRoute.test.ts
git diff --check
git add server/manuscript/project-creation-service.js src/pages/ProjectList.tsx server/tests/project-creation-journal.test.js tests/manuscriptRoute.test.ts
git commit -m "feat: enable file authority by default"
git status --short
```

- [ ] 若 Task 17A 未通过全部门禁，则保持 sqlite 默认并把状态固定为 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`；若全部通过，才提交上面的默认路由切换。无论选择哪条路，都必须先跑完所有本地 join、确认 `git status --porcelain=v1` 为空，然后冻结唯一的最终 source SHA。以下完整取证只在这个最终 SHA 上执行一次；此前所有开发提交均不得运行 13/19：

```powershell
$finalSourceCommit = (git rev-parse HEAD).Trim()
$finalStatus = @(git status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $finalStatus.Count -ne 0) { throw 'Final L2 source must be a clean commit' }
$evidenceRoot = 'D:\Mythpen\l1-vm\evidence'
$finalEvidencePath = Join-Path $evidenceRoot "l2-final-$finalSourceCommit"
$finalL1ManifestPath = Join-Path $evidenceRoot "windows-l1-reviewed-manifest-$finalSourceCommit.json"
foreach ($path in @($finalEvidencePath, $finalL1ManifestPath)) {
  if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite immutable final evidence: $path" }
}
New-Item -ItemType Directory -Path $finalEvidencePath -ErrorAction Stop | Out-Null
```

`$finalEvidencePath` 创建后即绑定 final source；每条命令的原始日志、退出码、结果路径和 SHA-256 都保存到该目录并进入仓库 ledger。失败时保留现场并停止，不得把部分结果称为 PASS，也不得为了“补一项”在另一个开发 SHA 上先跑 VM。

- [ ] 在调用任何 VM 前，先在冻结且干净的 `$finalSourceCommit` 上运行全文唯一一次完整本地源码回归与 build。任一失败都停止、修源码并重新形成新的 clean final commit；失败轮不得启动 13/19 VM。全部通过后再次确认工作树为空，才允许进入唯一 VM 重绑定：

```powershell
pnpm test:server
pnpm test:contracts
pnpm test:client
pnpm typecheck
pnpm exec biome check src/
pnpm build
$postLocalStatus = @(git status --porcelain=v1)
if ($LASTEXITCODE -ne 0 -or $postLocalStatus.Count -ne 0) { throw 'Final local regression changed or dirtied the frozen source' }
```

- [ ] 在最终提交上执行全文唯一一次 L1 13/19 VM 重绑定，并重跑 L2 三个 correctness/capacity 矩阵；不得复制历史 raw result、manifest 或结论。每条命令后立即检查真实退出码：

```powershell
node scripts/windows-l1-vm.mjs run-rollback-matrix --vm Mythpen-L1-Win10-LTSC2021
node scripts/windows-l1-vm.mjs run-directory-matrix --vm Mythpen-L1-Win10-LTSC2021
bun test --timeout 600000 server/tests/l2-correctness-matrix.test.js server/tests/l2-two-process-matrix.test.js server/tests/l2-capacity-boundary.test.js
```

- [ ] 由独立 reviewer 核对 13/13、19/19、L2 case 集、source/profile/probe/aggregate digest 与零 failure；只有通过后，才沿用现有 L1 v1 trust-root 流程生成新的 `$finalL1ManifestPath`。reviewer 对 raw evidence 与 manifest digest 的对应关系负责；不新增通用 publisher、receipt 或 attestation 平台。

```powershell
# 独立 reviewer 在核对通过后，以 CREATE_NEW/等价的 wx 方式写入 finalL1ManifestPath；
# 若路径已存在或任一 raw binding 不一致，停止且不构建 candidate。
```

- [ ] 使用现有、已验收的 production build 流程和新 L1 reviewed manifest 构建一次 candidate；不扩展 production build CLI。构建后复核 compiled build-info 的 source/mode/triple，记录 candidate 的绝对路径、字节数与 SHA-256：

```powershell
node scripts/build-sidecars.mjs --production-reviewed-manifest $finalL1ManifestPath
$finalCandidatePath = (Resolve-Path -LiteralPath '.\src-tauri\target\production-sidecars\mythpen-server-production-x86_64-pc-windows-msvc.exe').Path
```

- [ ] 在这个最终 candidate 上依次运行 compiled L1/L2 E2E、L1 native/save benchmark、L2 performance benchmark，以及 fresh debug desktop 的 lifecycle、files 与 migration-preflight smoke。compiled L2 E2E 必须复核 build-info 广告与 Task 8A lifecycle adapter、Task 9A platform feed、Task 9B state、Task 9C startup/teardown/fallback 的真实启动自检、两进程行为和 fail-closed 分支一致，不得用 source fake 代替；必须断言 ordinary dirty 始终走 FULL、没有 incremental模块/port/product接线且性能状态为 deferred。完整 server/contracts/client/typecheck/build 已在同一冻结 SHA、VM 之前唯一执行，本阶段不得重复。每个进程必须真实退出；Task 17A 样本不能替代最终样本。若默认决定是 deferred，E2E 必须断言 sqlite 仍为默认且显式实验入口可用；若是 default-ready，则断言 files 默认与显式 sqlite opt-out：

```powershell
$env:MYTHPEN_L1_PRODUCTION_CANDIDATE = $finalCandidatePath
$env:MYTHPEN_L1_REVIEWED_MANIFEST = $finalL1ManifestPath
node --test scripts/tests/l1-production-e2e.test.mjs
node --test scripts/tests/l2-production-e2e.test.mjs
bun test --timeout 600000 server/tests/native-durability-benchmark.test.js server/tests/l2-performance-benchmark.test.js
Remove-Item Env:MYTHPEN_L1_PRODUCTION_CANDIDATE, Env:MYTHPEN_L1_REVIEWED_MANIFEST -ErrorAction SilentlyContinue
pnpm tauri build --debug
```

- [ ] 用绝对 DesktopPath/SidecarPath 和事先不存在的 result path 执行 Task 15 三个 debug desktop smoke；保留原始结果并记录 hash，不复制 Task 16 的临时结果：

```powershell
$finalPreflightDesktopPath = (Resolve-Path -LiteralPath '.\src-tauri\target\debug\mythpen.exe').Path
$finalPreflightSidecarPath = (Resolve-Path -LiteralPath $finalCandidatePath).Path
$finalPreflightResultPath = [System.IO.Path]::GetFullPath((Join-Path $finalEvidencePath 'desktop-manuscript-migration-preflight.json'))
if (-not [System.IO.Path]::IsPathFullyQualified($finalPreflightResultPath) -or (Test-Path -LiteralPath $finalPreflightResultPath)) { throw "Final preflight ResultPath must be absolute and create-new: $finalPreflightResultPath" }
powershell.exe -NoProfile -File .\scripts\tests\desktop-manuscript-migration-preflight-smoke.ps1 -DesktopPath $finalPreflightDesktopPath -SidecarPath $finalPreflightSidecarPath -ResultPath $finalPreflightResultPath
```

- [ ] 独立 reviewer 最后复核所有日志、退出码、case count、source/triple、manifest/candidate/smoke/benchmark hash。只在全部成立后更新三份 evidence/spec 文档；不新增通用 publisher、build receipt、execution receipt 或 attestation。若性能未通过，文档只能写 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，不得写 `DEFAULT_READY`：

```powershell
git diff --check
git add docs/superpowers/plans/l2-production-candidate-acceptance.md docs/superpowers/plans/l2-performance-evidence.md docs/superpowers/specs/2026-08-15-l2-file-authority-spec.md
git commit -m "docs: attest L2 default-ready artifact"
```

**Final stop condition:** 只有最终 source 的唯一一次 13/19、L2 correctness/capacity、production candidate E2E、L1/L2 benchmark、完整回归、桌面 smoke 与 evidence hashes 同时有效，才能对外声明对应状态；Task 16/17A 的本地结果不能替代最终验收。任一 production source 变化都会使本轮结果失效，必须停止并重新经过本地 preflight；不得在日常开发提交上重复 VM 矩阵。

---

## Spec Coverage Checklist

- [ ] §1.1 L1 correctness 基线与默认启用前性能/VM 门禁：Task 1A、Task 17A–17B
- [ ] §4–6 权威布局、controlled role+UID API、规范字节、路径安全、精确/方言外/U+0000 Markdown：Task 3、Task 15、Task 16
- [ ] §7 schema 12、tombstone、positions、foreshadow：Task 2、Task 4、Task 5、Task 12–13
- [ ] §8 服务边界与全部写入口：Task 4–6、Task 7A–7B、Task 10B1–10B3、Task 9D wrapper、Task 14B final wiring
- [ ] §9 direct feed、freshness、`OPEN_EXISTING` lifecycle lease 与产品 admission：Task 8A、Task 8B、Task 9A–9D、Task 14B
- [ ] §10 FilePublicationJournal 及“只发布到 parent 已建立目录”：Task 6、Task 12–13
- [ ] §11 全资源域草稿冲突、epoch/intent/parent-child/audit/retention：Task 11A、Task 11B、Task 14B、Task 15、Task 16
- [ ] §12 host-only dirty-resource preflight、debug-only authenticated compiled-desktop harness、迁移、UID reservation、新建项目、parent 目录所有权：Task 11A–13、Task 14B–16、Task 17B
- [ ] §13 退役、重激活、数据根：Task 14、Task 14B、Task 15
- [ ] §14 错误、四个 orphan/external UID 出口、恢复与诊断：Task 2、Task 10A1、Task 10A2、Task 10B1–10B3、Task 11A、Task 14B–15
- [ ] §15 correctness/regression、compiled preflight 的绝对 DesktopPath/SidecarPath/ResultPath 与最终原始日志/退出码/hash 账本：Task 15–17B（Task 16 显式 join Task 2、3、4、5、6、7A、7B、8A、8B、9A、9B、9C、9D、10A1、10A2、10B1、10B2、10B3、11A、11B、12、13、14、14B、15；Task 10P 不在 source/join 中）
- [ ] §16 容量立即短路 seams、性能、默认启用：Task 3、Task 10A1、Task 10A2、Task 10B1、Task 10B3、Task 15–16、Task 17A–17B；Task 10P 固定 omitted
- [ ] §17 产品决定：所有任务均保持零 Git、迁移可延期、两级性能状态
