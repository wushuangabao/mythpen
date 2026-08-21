# L2 File Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 L1 原生耐久基线闭环后，把 Markdown/JSON 文件变成文章域唯一真值源，SQLite 仅作为可原子重建的活跃投影，并交付可恢复的写入、外部变化检测、迁移、草稿冲突与非破坏性退役。

**Architecture:** 所有文章写入收口到 `ManuscriptService`；`ManuscriptStore` 只理解安全路径、规范字节和文件闭包；`SQLiteProjectionStore` 只发布同一 generation 的完整投影；`ActiveManuscriptProjection` 是产品查询的唯一边界。Windows 普通会话以 shared lifecycle lease 保护，以三个 `ReadDirectoryChangesW` direct feed 维持新鲜度；写入、迁移、创建和草稿冲突分别由有父子所有权的 journal 状态机恢复。`project_meta.manuscript_route` 是路由真值，`config.db` 只保存可重建缓存。

**Tech Stack:** Bun 1.3.14、CommonJS 服务端、`bun:ffi`/Win32、NativeProjectStore/SQLite、Express、React 19 + Zustand + TypeScript、Tauri 2/Rust、Bun test、Node test、Biome。

## Global Constraints

- 实施依据是 `docs/superpowers/specs/2026-08-15-l2-file-authority-spec.md` 第 2.10 版；若计划与规范冲突，以规范为准并先修订计划。
- 第 2.10 版只调整门禁调度：允许 L2 correctness implementation 在 native p95 production evidence 前先行，但 `files` 始终保持实验性、非默认且不得称为 `DEFAULT_READY`；native p95 与全部 source-bound evidence 仍必须在 Task 17B 最终验收中通过。
- L2 开工只依赖 Task 1A 的 schema 11 安全准入、本地 contract 与 regression 基线；尚未闭环的 L1 production p95 和 source-bound Windows evidence 不阻塞 Task 2，统一延后到最终 L2 source 冻结后验收。
- 不创建 Git 仓库，不实现 L3/L4，不双写 SQLite 和文件，不搬迁数据根，不物理删除 `files` 项目。
- 每个产品任务都先写失败测试，再写最小实现，再跑聚焦测试；每个任务只提交列出的作用域，提交前运行 `git diff --check`。
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
          ├─ Task 4: 路由与活跃投影
          Task 3 + Task 4
              └─ Task 5: SQLiteProjectionStore
          Task 3 + Task 5
              └─ Task 6: FilePublicationJournal
                  └─ Task 7: ManuscriptService 领域命令与共享 UID reservation
          Task 4 + Task 6
              └─ Task 8: lifecycle lease/session admission
          Task 3 + Task 5 + Task 6 + Task 8
              └─ Task 9: direct feed/freshness
          Task 7 + Task 9
              └─ Task 9B: admission/freshness wrapper
                  ├─ Task 10: ignored ledger、孤儿出口与增量刷新
                  ├─ Task 11: DraftConflictJournal 与完整 dirty registry
                  └─ Task 12: MigrationJournal
                      └─ Task 13: ProjectCreationJournal
          Task 9B + Task 10 + Task 11 + Task 12 + Task 13
              └─ Task 14: 退役/重激活/换根屏障
          Task 9B + Task 10 + Task 11 + Task 12 + Task 13 + Task 14
              └─ Task 14B: 最终产品 API/CLI/读写入口接线
                  └─ Task 15: UI/诊断/宿主文件入口
          Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7 + Task 8 + Task 9 + Task 9B + Task 10 + Task 11 + Task 12 + Task 13 + Task 14 + Task 14B + Task 15
              └─ Task 16: 本地正确性 join/harness freeze（不发布 production evidence）
                                      └─ Task 17A: 可选最小性能 preflight 与默认路由 go/no-go（非 acceptance）
                                          └─ Task 17B: 落地默认决策、冻结最终 source，并完成唯一一次 production artifact 验收
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
function parseCanonicalJson({ role, bytes, expectedUid }) {}
function serializeCanonicalJson(role, value) {}
function inspectMarkdown(bytes) {}
function createCapacityAccumulator(limits, observer) {}

class ManuscriptStore {
  async enumerateAndClassify(identity) {}
  async validateFull(identity, ignoredLedger) {}
  async readControlledFile(identity, controlledFileRef) {}
  async buildProjectionCandidate(snapshot, previousProjection) {}
  async buildClosure(operation, activeProjection, ignoredLedger) {}
}
```

- [ ] 写路径测试：只接受规范小写 UUID；校验实际实名逐字节相等、case-fold 无碰撞、目录与文件非 reparse、普通文件 link count=1、规范 real path/物理身份稳定。
- [ ] `controlledFileRef` 只能由 `role = manuscript | unassigned | volume_index | chapter_body | chapter_sidecar` 加已经通过 `assertCanonicalUuid` 的 project/volume/chapter UID 构造，或者使用模块内部 branded reference；`readControlledFile()` 及所有调用方不得接收、拼接或透传相对路径、文件名、glob 或目录映射。负向测试把看似规范的 caller path、分隔符别名和错误角色/UID 组合全部拒绝。
- [ ] 固定目录布局与五种规范形状；识别 `<canonical>.<journal_id>.tmp` 为 journal candidate；孤儿与非受控残留分开，残留不读、不哈希、不改、不删。
- [ ] 实现四类 JSON 的稳定键序、UTF-8 无 BOM、LF、两空格、末尾单换行、未知字段拒绝、重复 UID/成员拒绝、`format_version` 过高专门报错。
- [ ] Markdown 先对 raw bytes 做 SHA-256，再验证 UTF-8；检测器精确识别可视方言：普通段落、一级/二级标题、粗体、斜体、下划线、行内代码、三反引号围栏代码块与 `---` 分隔线。合法 UTF-8 只要包含该方言之外构造就标记为 `read_only_passthrough`：查看、复制、导出与 sidecar/卷元数据写仍允许，AI 续写、提案应用、自动保存和其他语义性整篇正文写统一返回 `UNSUPPORTED_MARKDOWN_FOR_BODY_WRITE`，且不得重写 `.md`。含 U+0000 的合法 UTF-8 同样只读透传，投影 `chapters.content` 置空并标记不可用，但 raw hash、word count 与 generation 保持正确。
- [ ] 容量 accumulator 流式计数，超过任何维度立即返回包含 `dimension/observed/allowed` 的 `MANUSCRIPT_CONTENT_TOO_LARGE`；ignored 文件仍验证身份、大小并计量。提供只读 observer/counter seam，分别记录目录枚举数、身份 probe 数、内容打开数与累计字节；每个边界测试都断言第一次 `observed > allowed` 后不再枚举下一项、不再打开任何内容，单文件大小可由身份/metadata 证明时不得先打开超限文件。
- [ ] `validateFull()` 验证索引闭包、唯一归属、章节资源对完整、卷/章节生命周期 UID 合并计数、journal candidate 所有权；外部新 UID/孤儿返回 `EXTERNAL_RESOURCE_CREATION_UNSUPPORTED`。
- [ ] 为 80% 身份阈值产生持久诊断 warning，不因 tombstone 删除、ignored 文件删除或 revoke 释放容量。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-paths.test.js server/tests/manuscript-format.test.js server/tests/manuscript-capacity.test.js server/tests/manuscript-store.test.js
git diff --check
git add server/manuscript/paths.js server/manuscript/format.js server/manuscript/capacity.js server/manuscript/store.js server/tests/manuscript-paths.test.js server/tests/manuscript-format.test.js server/tests/manuscript-capacity.test.js server/tests/manuscript-store.test.js server/tests/fixtures/manuscript-tree.js
git commit -m "feat: add canonical manuscript store"
```

---

## Task 4: 建立 route 真值、缓存重建与 ActiveManuscriptProjection

**Depends on:** Task 2。

**Files:**

- Create: `server/manuscript/route-store.js`
- Create: `server/manuscript/active-projection.js`
- Modify: `server/recent-projects.js`
- Modify: `server/db.js`
- Create: `server/tests/manuscript-route-store.test.js`
- Create: `server/tests/active-manuscript-projection.test.js`
- Modify: `server/tests/recent-projects.test.js`

**Interfaces:**

```js
class ManuscriptRouteStore {
  readRoute(projectDb) {} // missing key => sqlite
  compareAndSwap(projectDb, expected, next, binding) {}
  rebuildConfigCache(projectRegistry) {}
}

class ActiveManuscriptProjection {
  listVolumes(db, options) {}
  listChapters(db, options) {}
  getChapter(db, chapterId) {}
  resolveLegacyChapterNumber(db, volumeId, num) {}
  exportSnapshot(db) {}
}
```

- [ ] 测试缺失 route 键等价 `sqlite`；重复、非法组合或 `migrating` 无有效 journal 时返回 `MIGRATION_STATE_MISMATCH`。
- [ ] route CAS 同时绑定 project UID、project instance、数据库/文章根物理身份和 projection generation；保留键只允许内部 capability 修改。
- [ ] `config.db` 缓存删除、损坏或陈旧后可从所有项目数据库重建，不能反向覆盖项目 route 真值。
- [ ] 所有活跃查询强制 `volumes.is_present=1`、`chapters.is_present=1` 且父卷为空或活跃；诊断接口用单独 capability 读取 tombstone。
- [ ] 主身份改为稳定本机 `chapter_id`；旧 `volume_id + num` 路由只查活跃行，歧义显式拒绝；未分卷章节具备完整 CRUD/导出查询能力。
- [ ] 阅读顺序、进度和 overdue 改用 `manuscript_position`，断言 `currentMax >= expected` 即 overdue。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-route-store.test.js server/tests/active-manuscript-projection.test.js server/tests/recent-projects.test.js
git diff --check
git add server/manuscript/route-store.js server/manuscript/active-projection.js server/recent-projects.js server/db.js server/tests/manuscript-route-store.test.js server/tests/active-manuscript-projection.test.js server/tests/recent-projects.test.js
git commit -m "feat: add manuscript routing and active projection"
```

---

## Task 5: 实现同 generation 的 SQLiteProjectionStore

**Depends on:** Task 3 + Task 4。

**Files:**

- Create: `server/manuscript/projection-store.js`
- Create: `server/tests/manuscript-projection-store.test.js`

**Interfaces:**

```js
class SQLiteProjectionStore {
  readGeneration(db) {}
  buildTarget({ snapshot, ignoredLedger, capacitySnapshot, proposalInvalidations }) {}
  publish({ projectStore, expectedGeneration, targetGeneration, target, routeCas }) {}
}
```

- [ ] 使用只记录 transaction/CAS/commit disposition 的 fake `projectStore` 写聚焦失败测试，覆盖 generation CAS 失败、事务 preflight 失败、commit disposition unknown、代码/meta/schema trigger digest 不一致与 schema too new；本任务不打开真实 NativeProjectStore，也不把 fake 结果称为 schema 12 live admission 证据。
- [ ] 一个 target 必须同时包含正文、sidecar 字段、UID、tombstone、positions、raw hashes、ignored ledger 及成员状态、容量快照、proposal stale 变化和 projection generation。
- [ ] full refresh 复用既有整数 ID；新 UID 分配新 ID；移除对象 tombstone；同 UID 再现复活；用两阶段 position 更新规避部分唯一索引冲突。
- [ ] `chapters.content`、hash、word count 与 sidecar 字段必须源自同一已验证 snapshot，并在一个 NativeProjectStore 事务中可见。
- [ ] migration 最终 publish 可额外原子 CAS `migrating → files`，测试不存在“投影已提交但路由未切换”或反向中间态。
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
- Create: `server/tests/file-publication-journal.test.js`
- Create: `server/tests/file-publication-crash.test.js`
- Create: `server/tests/fixtures/file-publication-crash.js`

**State model:**

```text
prepared → files_published → projection_committed → completed
```

```js
class FilePublicationJournal {
  async prepare({ logicalRequestId, baseGeneration, targetGeneration, closure, projectionTarget, parent }) {}
  async publishFiles(journalId) {}
  async commitProjection(journalId) {}
  async complete(journalId) {}
  async recover(journalId) {}
}
```

- [ ] 写最小闭包表测试：正文更新=1 md，sidecar 更新=1 json，移动章节=源/目标索引，章节创建/删除=索引+资源对，卷结构操作只触及精确结构文件。
- [ ] `prepared` 冻结 logical request、UID/整数 ID、before/after raw SHA-256、after-absent 谓词、候选相对路径、目标 generation 和 projection target。
- [ ] 每个候选与目标路径校验普通文件身份、实名和链接计数；文件 flush、replace、目录 flush 的 disposition 必须可证明，持续外部占用返回 `MANUSCRIPT_TARGET_LOCKED`。
- [ ] child journal 记录 parent ID 后不得自行提交父 projection/route；普通 journal 才可调用 projection store。
- [ ] FilePublicationJournal 只向已经由普通项目现场、MigrationJournal 或 ProjectCreationJournal 建立并验证的 `mythpen/`、`volumes/`、`chapters/` 目录发布文件；它不得创建、删除或接管这些目录，也不得把目录建立藏进 `prepared`。
- [ ] 在状态追加前后、每个候选发布前后、projection commit 前后和 cleanup 前后注入强杀；恢复只能收敛完整 before、完整 after 或 `RECOVERY_REQUIRED`。
- [ ] 对外部 CAS 变化返回 `EXTERNAL_CHANGE_CONFLICT`，不得覆盖现场；终态证据成立后才清理 journal candidates，无法归属的同形状候选保留为残留。
- [ ] 运行并提交：

```powershell
bun test server/tests/file-publication-journal.test.js server/tests/file-publication-crash.test.js
git diff --check
git add server/manuscript/file-publication-journal.js server/manuscript/file-publisher.js server/tests/file-publication-journal.test.js server/tests/file-publication-crash.test.js server/tests/fixtures/file-publication-crash.js
git commit -m "feat: add recoverable file publication journal"
```

---

## Task 7: 实现不依赖会话层的 ManuscriptService 领域命令

**Depends on:** Task 6。

**Files:**

- Modify: `server/manuscript-service.js`
- Create: `server/manuscript/uid-reservation.js`
- Create: `server/tests/manuscript-service-l2.test.js`
- Create: `server/tests/manuscript-uid-reservation.test.js`

**Interfaces:**

```js
class ManuscriptUidReservation {
  reserveNewIdentity({ kind, logicalRequestId, activeProjection, ignoredLedger, reservationSources, pathProbe }) {}
}

function createL2ManuscriptService({ manuscriptStore, fileJournal, projectionStore, uidReservation }) {
  return {
    execute(command, turnContext) {},
  };
}
```

- [ ] `command` 使用明确 discriminated kind 覆盖正文、sidecar、章节/卷创建、改名、移动、重排、删除；`turnContext` 只接收已经验证的 active projection、base generation、ignored ledger、logical request ID 和草稿冲突决定，不负责 session admission 或 freshness。
- [ ] 在本任务建立全系统唯一的 `ManuscriptUidReservation`；章节/卷创建必须在 FilePublicationJournal `prepared` 之前，用 CSPRNG seam 产生规范 UUIDv4，并联合检查 active projection、tombstone、ignored ledger、规范路径和注入的未终结 migration/creation reservation sources。任一来源不能完整枚举即 fail-closed；同一 logical request 冻结并复用原 UID，碰撞不进入任何文件副作用。
- [ ] 每个领域命令只生成精确 closure、before/after CAS、经共享 reservation 服务取得的 UID/整数 ID 与 projection target，再调用 FilePublicationJournal；不得直接取得 lifecycle/writer lease，也不得直接调用 REST、Zustand 或平台 feed。
- [ ] 删除章节/卷只通过权威结构移除 + SQLite tombstone；卷仍承载 indexed ignored 章节时在任何文件副作用前返回 `IGNORED_REFERENCE_BLOCKS_CONTAINER_DELETE`。
- [ ] 用 fake store/journal/projection/reservation source 写纯领域测试，证明各命令的闭包、UID 幂等/碰撞/不完整枚举与 tombstone/position/opaque ignored 语义；生产路由接线明确推迟到 Task 9B。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-service-l2.test.js server/tests/manuscript-uid-reservation.test.js server/tests/file-publication-journal.test.js
git diff --check
git add server/manuscript-service.js server/manuscript/uid-reservation.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-uid-reservation.test.js
git commit -m "feat: add L2 manuscript domain commands"
```

---

## Task 8: 实现 Windows lifecycle lease 与 session admission

**Depends on:** Task 4 + Task 6。

**Files:**

- Create: `server/platform/windows-manuscript-lifecycle-lease.js`
- Create: `server/manuscript/session-controller.js`
- Create: `server/tests/windows-manuscript-lifecycle-lease.test.js`
- Create: `server/tests/manuscript-session-controller.test.js`
- Create: `server/tests/fixtures/manuscript-lifecycle-worker.js`
- Modify: `server/native/production-native-activation-controller.js`
- Modify: `server/build-info.js`

**Interfaces:**

```js
function createWindowsManuscriptLifecycleLeaseAdapter(options) {
  return {
    capability: false,
    acquireShared(identity) {},
    acquireExclusive(identity) {},
  };
}

class ManuscriptSessionController {
  async admit(projectIdentity, operation) {}
  async beginRetiring(projectIdentity) {}
  async drain(projectIdentity) {}
  async close(projectIdentity) {}
}
```

- [ ] `bun:ffi` adapter 只对规范 sibling `.manuscript-<sha256(canonical-real-control-directory)>.lifecycle.lock` 使用 `CreateFileW` + `LockFileEx`；`dwCreationDisposition` 固定为 `OPEN_EXISTING`，adapter 永不创建或补建锁文件；只有 Task 12 MigrationJournal 与 Task 13 ProjectCreationJournal 父协议可创建它。打开时读写共享、不共享 delete、锁 `[0,1)`、fail immediately。
- [ ] 两进程测试 shared/shared 成功，shared/exclusive、exclusive/shared、exclusive/exclusive 稳定映射 `PROJECT_WRITE_BUSY`；真实路径与允许别名汇聚同一物理锁。
- [ ] 强杀 owner 后可重新取得；Unlock/Close/符号缺失/身份变化/disposition unknown 注入时，只有 close 已知成功才证明释放，其余 fenced 或 `MANUSCRIPT_LIFECYCLE_UNAVAILABLE`。
- [ ] session 进程内 ref-count shared handle；取得后重读 route、project UID/instance、数据库/文章根身份、generation 和父 journal 终态，再开放普通请求。
- [ ] 所有普通读取、写入、自动保存、导出、AI 上下文从 admission 到完成都计入 in-flight；禁止 shared→exclusive 原地升级。
- [ ] capability 由精确 Bun 1.3.14 Windows x64 production adapter 实测后才设 true，启动自检任一失败均 false/fail-closed。
- [ ] 运行并提交：

```powershell
bun test --timeout 30000 server/tests/windows-manuscript-lifecycle-lease.test.js server/tests/manuscript-session-controller.test.js
git diff --check
git add server/platform/windows-manuscript-lifecycle-lease.js server/manuscript/session-controller.js server/tests/windows-manuscript-lifecycle-lease.test.js server/tests/manuscript-session-controller.test.js server/tests/fixtures/manuscript-lifecycle-worker.js server/native/production-native-activation-controller.js server/build-info.js
git commit -m "feat: protect file-authority sessions with lifecycle leases"
```

---

## Task 9: 实现 direct feed、线性化 feed-state 与 freshness gates

**Depends on:** Task 3 + Task 5 + Task 6 + Task 8。

**Files:**

- Create: `server/platform/windows-manuscript-change-feed.js`
- Create: `server/manuscript/feed-state.js`
- Create: `server/manuscript/freshness.js`
- Create: `server/tests/windows-manuscript-change-feed.test.js`
- Create: `server/tests/manuscript-feed-state.test.js`
- Create: `server/tests/manuscript-freshness.test.js`
- Create: `server/tests/fixtures/manuscript-feed-worker.js`
- Modify: `server/manuscript/session-controller.js`
- Modify: `server/build-info.js`

**Interfaces:**

```js
class ManuscriptFeedState {
  snapshot() {}
  observeCompletion(feedId, handleInstance) {}
  arm(feedId, handleInstance) {}
  accountCompletion(feedId, dirtyPaths, coverageLost) {}
  claimRefresh(baseGeneration) {}
  settleRefresh(claimId, result) {}
}

async function ensureProjectionCurrent(session, options = {}) {}
async function ensureReadableProjection(session, query) {}
```

- [ ] 每项目直接打开 root/volumes/chapters 三个非递归目录句柄；每个独立 OVERLAPPED、manual-reset event、1 MiB kernel buffer、双 user buffer，不共享 delete access。
- [ ] feed-state 在一把 mutex/单写者执行器下原子维护 handle instance、armed、observed/accounted、dirty、refresh claim、base generation、coverage-loss epoch；每 feed 至多一个未 accounted completion。
- [ ] 确定性交错测试“后台已取 completion 未解析”“重新布防失败”“解析抛错”“新事件落在 refresh claim 后”，全部不能 false-clean。
- [ ] 零字节、`ERROR_NOTIFY_ENUM_DIR`、记录边界/UTF-16 错误、句柄失效、实例重建、未全 armed、能力 false 均先锁存 `coverageLost`/全脏。
- [ ] 每次 `ensureProjectionCurrent()` 在 writer lease 内同步排空三个 event 和 observed/accounted 差值；具体 dirty 做增量，coverage loss/启动/显式刷新/恢复/迁移做完全校验。
- [ ] 启动顺序固定“shared lease → 三 feed armed → 全脏 claim → 完全校验 → 排空窗口事件 → 发布可信基线”；只有成功完整校验可清 coverageLost。
- [ ] `ensureReadableProjection()` 查询前后各做三 event 零超时 probe + 单一线性化快照；检测变化时不得返回旧查询结果，最多有界重试后报 `MANUSCRIPT_TREE_CHANGED_DURING_READ`。
- [ ] 自我事件只能按 journal after hash + generation 对消；commit unknown、取消或 refresh 失败把 claim 合回 dirty或保持 coverage lost。
- [ ] 每进程最多一个 armed `files` 项目，预算约 9 MiB；无 slot 会话仍持 shared lifecycle lease并常置全脏，UI 标识降级。
- [ ] 生产 capability 默认 false，完整原矩阵与资源预算通过后才将 `manuscriptChangeNotification` 置 true。
- [ ] 运行并提交：

```powershell
bun test --timeout 60000 server/tests/windows-manuscript-change-feed.test.js server/tests/manuscript-feed-state.test.js server/tests/manuscript-freshness.test.js
git diff --check
git add server/platform/windows-manuscript-change-feed.js server/manuscript/feed-state.js server/manuscript/freshness.js server/tests/windows-manuscript-change-feed.test.js server/tests/manuscript-feed-state.test.js server/tests/manuscript-freshness.test.js server/tests/fixtures/manuscript-feed-worker.js server/manuscript/session-controller.js server/build-info.js
git commit -m "feat: maintain manuscript projection freshness"
```

---

## Task 9B: 建立 admission/freshness wrapper

**Depends on:** Task 7 + Task 9。此任务不得修改任何 REST、AI、导出、自动保存或产品入口；真实冲突 gate、ignored 动作与迁移/创建/退役接线统一推迟到 Task 14B。

**Files:**

- Create: `server/manuscript/product-gates.js`
- Create: `server/tests/manuscript-product-gates.test.js`

**Interfaces:**

```js
async function withCurrentManuscriptWriteTurn(projectIdentity, logicalRequestId, callback) {
  // Task 8 session admission → writer lease → Task 9 freshness → injected policy gate → callback(turnContext)
}

async function withReadableManuscriptProjection(projectIdentity, query) {
  // Task 8 session admission → Task 9 ensureReadableProjection(session, query)
}
```

- [ ] 用 fake admission/writer/freshness/policy/service 实现纯 wrapper 测试，固定取得与释放顺序；policy gate 是显式必填依赖，当前只可使用 fail-closed fake，不得把尚未实现的 DraftConflictJournal 或 ignored 行为伪装成可用产品能力。
- [ ] `withCurrentManuscriptWriteTurn()` 只在 admission、writer、freshness 与注入 gate 全部成功后调用 callback；失败、取消和 stale response 不创建 FilePublicationJournal candidate，也不清除 feed dirty、refresh claim 或未来 conflict evidence。
- [ ] `withReadableManuscriptProjection()` 只包装 session admission、`ensureReadableProjection()` 与 ActiveManuscriptProjection 查询，并固定 generation/connection epoch 传递；本任务不把任何现有产品读入口宣称为已迁移。
- [ ] 本任务不修改静态扫描器或 SQL guard，也不建立临时 allowlist；文章真值 SQL、受控文件直写、freshness 绕过、tombstone 读取、`MAX(num)` 与旧伏笔编号的完整 RED→零债务扫描统一在 Task 14B 与产品接线同一次完成。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-product-gates.test.js
git diff --check
git add server/manuscript/product-gates.js server/tests/manuscript-product-gates.test.js
git commit -m "feat: establish L2 product gate foundation"
```

---

## Task 10: 实现 ignored identity ledger、孤儿出口与安全增量刷新

**Depends on:** Task 9B。

**Files:**

- Create: `server/manuscript/ignored-ledger.js`
- Create: `server/manuscript/orphan-resolution-service.js`
- Create: `server/manuscript/incremental-refresh.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/projection-store.js`
- Modify: `server/manuscript-service.js`
- Create: `server/tests/manuscript-ignored-ledger.test.js`
- Create: `server/tests/manuscript-orphan-resolution.test.js`
- Create: `server/tests/manuscript-incremental-refresh.test.js`

**Interfaces:**

```js
class IgnoredIdentityLedger {
  ignoreInPlace(record) {}
  revoke(uid, kind) {}
  moveOpaqueReference(uid, targetContainer) {}
  detachOpaqueReference(uid) {}
  serializeOpaqueMembers(container, knownMembers) {}
}

class OrphanResolutionService {
  ignoreInPlace(request, turnContext) {}
  revokeIgnore(request, turnContext) {}
  preserveAndMoveToUnassigned(request, turnContext) {}
  detachOpaqueReference(request, turnContext) {}
}
```

- [ ] `active|revoked` 记录永久保留 UID；active 保存规范成员集合、存在性、大小、普通文件身份、`indexed|detached` 和当前容器。
- [ ] 后端纯服务完整实现四个用户动作：就地忽略、撤销忽略、保留并转为未分卷、解除不透明索引引用。就地忽略/撤销只更新同 generation ledger/projection；转未分卷固定闭包为原索引 + `unassigned.json`；解除引用固定闭包为原索引。所有动作都要求 writer turn、before/after ledger、索引 raw-hash CAS 和 generation CAS，任一 stale 均零本动作副作用。
- [ ] ignore/revoke 仍枚举规范形状、实名、非 reparse、link count、单文件/项目容量；只跳过 UTF-8/JSON 语义解释。
- [ ] 索引重写把同容器 indexed opaque members 稳定追加到末尾，多个按 UID UTF-8 字节序；普通重排不能丢失不透明引用。
- [ ] “保留并转未分卷”闭包为原索引+`unassigned.json`；“解除索引引用”闭包为原索引；ignored before/after、索引 raw hash 和 generation 同 journal 发布。
- [ ] active ignored 路径 dirty 时重枚举全部成员并用 before capacity snapshot 算增量；before 无法证明、事件含糊或快照不完整时锁存全脏。
- [ ] 已索引未知 UID、孤儿、单边章节资源、卷删除阻断、容量超限、revoke 后再出现分别按规范错误收敛；不移动或删除用户文件。
- [ ] 四个动作的测试逐字节比较全部资源文件：服务永不移动、删除、重命名或重写用户资源 bytes；“保留并转为未分卷”和“解除索引引用”只允许改动规范索引与 SQLite ledger/projection。这里只交付 backend/service semantics，不修改 route/CLI/UI；最终 API 接线在 Task 14B，UI 与交互测试在 Task 15。
- [ ] 增量刷新按 UID 扩展最小结构闭包；索引变化、归属含糊和未知新 UID 升级完全校验，不能凭局部信息猜测删除/创建。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-orphan-resolution.test.js server/tests/manuscript-incremental-refresh.test.js server/tests/manuscript-store.test.js
git diff --check
git add server/manuscript/ignored-ledger.js server/manuscript/orphan-resolution-service.js server/manuscript/incremental-refresh.js server/manuscript/store.js server/manuscript/projection-store.js server/manuscript-service.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-orphan-resolution.test.js server/tests/manuscript-incremental-refresh.test.js
git commit -m "feat: preserve ignored manuscript identities"
```

---

## Task 11: 实现 DraftConflictJournal 与客户端 dirty registry

**Depends on:** Task 9B。

**Files:**

- Create: `server/manuscript/draft-conflict-journal.js`
- Create: `server/manuscript/draft-conflict-service.js`
- Create: `server/tests/draft-conflict-journal.test.js`
- Create: `server/tests/draft-conflict-crash.test.js`
- Create: `server/tests/fixtures/draft-conflict-crash.js`
- Create: `src/lib/dirtyResourceRegistry.ts`
- Create: `src/lib/manuscriptConflicts.ts`
- Modify: `src/stores/useEditorStore.ts`
- Modify: `src/stores/useChapterStore.ts`
- Create: `tests/dirtyResourceRegistry.test.ts`
- Create: `tests/manuscriptConflicts.test.ts`
- Modify: `tests/editorSaveQueue.test.ts`

**Interfaces:**

```text
conflict_detected → backup_durable → decision_ready(epoch = 0)
  → resolve_accept_intent(epoch) → resolved_accept_external → archived
  → resolve_apply_intent(epoch)
      → resolved_apply_draft → archived
      → resolve_apply_aborted → decision_ready(epoch + 1)

backup_durable | decision_ready | resolve_accept_intent（projection 仍精确为 before）
  → superseded
```

```ts
type DirtyResourceKey =
  | `${string}:body`
  | `${string}:sidecar`
  | `${string}:volume-metadata`
  | `${string}:structure`;
type DraftConflictResolution = "accept_external" | "apply_saved_draft";

interface DirtyResourceRegistry {
  markDirty(key: DirtyResourceKey, baseRawSha256: string): void;
  markSaving(key: DirtyResourceKey, requestId: string): void;
  settle(key: DirtyResourceKey, requestId: string, result: "saved" | "stale" | "failed"): void;
  snapshot(): ReadonlyArray<DirtyResourceState>;
}
```

- [ ] dirty registry 覆盖所有文章域：已加载正文、自动保存防抖、已卸载正文保存队列；标题/大纲/状态/摘要/五个叙事字段 sidecar；卷标题/卷摘要 metadata；移动/重排 structure queue；以及多窗口尚未提交字段。正文、sidecar、卷 metadata 与 structure 分域；同一资源域相撞才冻结该资源，其他资源仍可刷新。
- [ ] server conflict journal 在独立资产根持久保存不可变 draft bytes/hash、field mask、external bytes/hash、base generation、资源域、`supersedes`、decision epoch 与状态；`backup_durable` 必须在向 UI 报告草稿已保留前完成 file fsync 与 parent fsync。诊断包不含正文，只含 conflict/supersedes/epoch/child、hash、大小、field mask 和状态。
- [ ] 恢复 `conflict_detected` 且 backup 不完整时只删除该 conflict 记录并在完全校验重建；`backup_durable` 验证 backup 后只能追加首个 `decision_ready(0)`；只有 `decision_ready(epoch)` 可接收用户选择，恢复流程绝不自动选边。
- [ ] 两个 intent 必须在任何副作用前落盘。`resolve_apply_intent` 冻结 epoch、唯一 child FilePublicationJournal ID、外部 raw-hash CAS、projection before/target generation；`resolve_accept_intent` 冻结 epoch、接受 hash、资源 UID 与 projection before/target generation。旧 epoch 请求、迟到重试和旧 child 永久 stale。
- [ ] `apply_saved_draft` 经 writer lease、freshness、外部 raw hash CAS 和 child FilePublicationJournal 发布；child 必须先到 `completed`，父才可写 `resolved_apply_draft`，child 未终结时父不得 `archived`，child 不得写父状态。child 收敛完整 before 时父依次追加 `resolve_apply_aborted` 和 `decision_ready(epoch + 1)`；完整 after 时写 `resolved_apply_draft`；无法证明进入 `RECOVERY_REQUIRED`。
- [ ] apply intent 绝不能直接 `superseded`。外部再次变化或用户取消时先恢复 child；只有 `backup_durable`、`decision_ready`，或 projection 仍精确为 before 的 `resolve_accept_intent` 可转 `superseded`。新 conflict 的 `supersedes` 指向旧 conflict，旧 backup 保留。
- [ ] accept 使用 before-generation CAS 发布含已接受 raw hash 的目标 projection；只有 commit 已确定成功后才能追加 `resolved_accept_external`。若 projection 已为目标 generation/hash，即使文件后来又变，也必须先补写 `resolved_accept_external`，再为后续变化新建 conflict，审计顺序不得把已生效 accept 直接写成 superseded。
- [ ] `archived` 与 `superseded` 是唯一可回收状态，保留最近 20 份或 30 天、取较宽者；其他状态永不回收。归档、supersede 链、retention 边界和 GC debt 都有确定性测试。
- [ ] 外部 sidecar `status` 变化使 pending proposal stale，只有移动/重排不转 stale。页面刷新、项目切换、已卸载队列、多窗口请求乱序和失败重试都不能丢 dirty 状态；只有匹配 request ID 的成功响应可清除。
- [ ] 逐状态 crash tests 覆盖 backup 写入/fsync 前后、两个 intent 前后、child 每个发布/complete 点、apply abort/epoch 增长、accept projection commit 成功但 audit 未落盘、archive/supersede/retention；每次恢复只形成规范允许的事件序列。真实 route 与冲突对话框接线推迟到 Task 14B/15。
- [ ] 运行并提交：

```powershell
bun test server/tests/draft-conflict-journal.test.js server/tests/draft-conflict-crash.test.js
node --test --test-concurrency=1 tests/dirtyResourceRegistry.test.ts tests/manuscriptConflicts.test.ts tests/editorSaveQueue.test.ts
pnpm typecheck
git diff --check
git add server/manuscript/draft-conflict-journal.js server/manuscript/draft-conflict-service.js server/tests/draft-conflict-journal.test.js server/tests/draft-conflict-crash.test.js server/tests/fixtures/draft-conflict-crash.js src/lib/dirtyResourceRegistry.ts src/lib/manuscriptConflicts.ts src/stores/useEditorStore.ts src/stores/useChapterStore.ts tests/dirtyResourceRegistry.test.ts tests/manuscriptConflicts.test.ts tests/editorSaveQueue.test.ts
git commit -m "feat: recover external manuscript draft conflicts"
```

---

## Task 12: 实现 SQLite→files MigrationJournal

**Depends on:** Task 9B。

**Files:**

- Modify: `server/native/durability-schema.js`
- Modify: `server/native/native-project-store.js`
- Modify: `server/native/native-sql-authorization.js`
- Modify: `server/testing/native-stage-b-fixture.js`
- Modify: `server/testing/native-stage-b-store.js`
- Modify: `server/db.js`
- Modify: `server/manuscript-sql-guard.js`
- Modify: `server/manuscript/uid-reservation.js`
- Create: `server/manuscript/migration-journal.js`
- Create: `server/manuscript/migration-service.js`
- Modify: `server/manuscript-service.js`
- Modify: `server/tests/durability-schema.test.js`
- Modify: `server/tests/manuscript-schema-12.test.js`
- Modify: `server/tests/native-project-store.test.js`
- Modify: `server/tests/native-project-store-crash.test.js`
- Modify: `server/tests/manuscript-uid-reservation.test.js`
- Modify: `server/tests/manuscript-service-l2.test.js`
- Create: `server/tests/manuscript-migration.test.js`
- Create: `server/tests/manuscript-migration-crash.test.js`
- Create: `server/tests/fixtures/manuscript-migration-crash.js`

**State model:**

```text
migration_reserved → route_fenced → source_snapshot_ready
→ files_candidate_ready → file_publication_started → files_published
→ database_candidate_ready → activation_intent → activated

before activation_intent, with child at complete files before:
  migration_abort_intent → migration_aborted
unprovable state: RECOVERY_REQUIRED
```

- [ ] “稍后升级”测试 route、journal、reservation、目标根与业务字节零变化；未显式实验启用时不弹默认迁移、不创建 files 项目。
- [ ] 用户确认前完成 dirty draft 处理、云同步/reparse 风险说明、备份确认；确认后在 registry/config lease + writer lease 下写 `migration_reserved`。
- [ ] 扩展 Task 7 的同一个 `ManuscriptUidReservation`，把 registry、现存 roots、未 GC MigrationJournal/ProjectCreationJournal 暴露为正式 reservation sources；不得在 migration service 内实现第二套扫描或抽号逻辑。CSPRNG seam 继续生成规范 UUIDv4，按 project/chapter/volume 命名空间扫描，任一来源不完整即 fail-closed。
- [ ] 把这些正式 reservation sources 注入 `ManuscriptService`，验证普通章节/卷创建与 migration/creation 共享同一碰撞域；已有 logical request/migration ID 逐项复用冻结 UID。
- [ ] reservation 在 route fence 前落盘并冻结；同 migration ID 的重试逐项复用；落盘后碰撞返回 `UID_RESERVATION_COLLISION`，绝不重抽。
- [ ] route fence 是 reservation 之后第一个目标副作用；`migrating` 下所有普通入口返回 `PROJECT_MIGRATION_BUSY`。
- [ ] 在 Task 2 的 v2 descriptor/inspector 上只建立一套 schema 12 candidate builder/installer。它接收已冻结的 source contract、UID reservation、完整 target projection 与 `sourceKind = schema11 | empty`；migration 分支必须在唯一离线 candidate 上逐列保留业务行、整数 ID、`sqlite_sequence`、外键、视图与非冲突索引，重建 RESTRICT、物理 DELETE barrier、两个活跃编号部分唯一索引及全部 v2 canonical triggers，禁止 `CREATE TABLE AS SELECT`。UID、positions、raw hashes、ignored/容量快照和伏笔位置只能来自 frozen input，不得在 builder 内随机生成或从旧 `num` 猜测。
- [ ] builder 对 schema11 source 先做 v1 instance/seq/gate/digest 精确 preflight，再在事务外关闭 foreign keys、按依赖图于事务内重建、完成 `integrity_check`/`foreign_key_check`/ID 集合/行数/sequence/schema 指纹/v2 三方 digest 后提交并恢复 foreign keys；未知依赖返回 `SCHEMA_SWAP_UNSUPPORTED`。任一注入失败都恢复 PRAGMA 并只留下未发布 candidate，source DB 与 ControlStore 字节不变。
- [ ] 将 `PROJECT_SCHEMA_VERSION` 从 11 提升到 12，但 `SQLJS_PROJECT_SCHEMA_VERSION` 继续为 10。`db.js` 与 NativeProjectStore 必须显式分支：schema11 仍逐次验证原 native activation evidence 与 v1 contract；schema12 必须同时验证原 activation/creation basis、v2 inspector，以及规范 `database_candidate_ready → activation_intent → activated` transition proof；schema13+ 在 open、事务 preflight 和 DML 前零修改返回 `PROJECT_SCHEMA_TOO_NEW`。live schema 或调用者参数不能自证 transition。
- [ ] transition proof 精确绑定 kind=`migration | new_creation`、before/after schema 与 trigger digest、project instance、before/final commit seq、candidate identity、parent journal ID/digest 和 target generation。Task 12 实现并消费 `migration` kind；同时把 verifier/builder 作为 Task 13 的唯一 `new_creation` 接口，不新增平行 ControlStore 事件链。
- [ ] `native-sql-authorization.js` 与 sql.js guard 共同消费 Task 2 的四个 `RESERVED_PROJECT_META_KEYS`：普通业务 SQL 在 schema11 route fence 前后及 schema12 都不能插入、更新、删除或借 CTE/subquery/复杂 predicate 间接修改这些键；只有绑定同一 transition/journal 的内部语句可写。schema12 的章节/卷物理 DELETE 由 authorization 与 v2 barrier 双重拒绝，schema11 的 legacy sqlite 删除语义在 Task 14B 接线前保持不变。
- [ ] 把 Stage B fixture/store 改为显式 versioned fixture：既有 schema11 genesis、payload exact keys、18/54/digest 与全部测试值不变；schema12 fixture 必须由真实 v2 candidate + 持久 transition proof 建立，不能靠测试参数或 live schema 自证。用该 fixture 聚焦验证冷启动、cached open、事务 preflight、commit 后、recovery 与 transition 漂移拒绝。
- [ ] route fence 后由 MigrationJournal parent 创建或验证规范 lifecycle lock，并记录 before/after 身份及 file/parent flush 谓词；Task 8 adapter 只可 `OPEN_EXISTING`。随后建立一致源快照与迁移前备份，完成 integrity、foreign-key、旧章节编号、伏笔预期位置、schema 依赖、容量和目标缺席检查。只有这些谓词、源/备份身份与 SHA-256 全部冻结后才写 `source_snapshot_ready`；任何不明确分别返回对应 legacy/schema 错误，不能进入文件候选阶段。
- [ ] `route_fenced` 冻结 `<data>/manuscripts/<project_uid>/`、`mythpen/`、`volumes/`、`chapters/` 四级目录逐级 before/after canonical real identity、父身份、absent/owned 谓词和本 migration ID 所有权，且必须早于第一个 `mkdir`。parent 在进入既有 `source_snapshot_ready/files_candidate_ready` 阶段的动作中逐级创建并重新 canonicalize，fsync 每个新目录及其父目录；身份不符进入 `RECOVERY_REQUIRED`。不新增 `directories_ready` 等规范外状态。
- [ ] `files_candidate_ready` 冻结唯一 child journal ID、候选 tree after digest、唯一数据库 after candidate digest、共同 target generation、目标身份和完整 files before/after 谓词；parent 不得创建第二个 child 或第二份数据库 candidate。
- [ ] parent 必须在 child 的第一次候选/发布副作用前持久化 `file_publication_started`；child FilePublicationJournal 只负责 `prepared → files_published` 并收敛完整 files before/after，不得写 projection、activation 或 parent 状态。child 完整 after 后 parent 才写 `files_published`，调用本任务唯一 builder 构造/验证 populated schema 12 candidate，并写入上述持久 transition proof。最终一次 NativeProjectStore publish 同时提交完整投影和 route `files`，重启 admission 只能消费该规范 proof，不接受 live schema 自证。
- [ ] child 只能把文件发布到 parent 已建立且身份匹配的三个受控目录，永不创建目录。`activation_intent` 前只有 child 可证明完整 files before，且 parent 可逐级证明目录是本 migration 创建、没有外部/非 owned 内容、没有未知句柄并满足安全删除谓词时，才可由 parent 自内向外删除 owned 目录并 fsync 父目录、删除本 migration 从 absent 创建的 lifecycle lock、CAS 回 sqlite；before 已存在目录/锁只验证并保留。任一目录所有权或内容不明确都不得删除，进入 `RECOVERY_REQUIRED`；之后只能前滚。源 DB 和迁移前备份永久保留。
- [ ] 恢复顺序固定为：先恢复 L1 journal；联合加载 route 与唯一 MigrationJournal；处理合法 `sqlite + migration_reserved` reservation；验证 `migrating` 绑定并补齐 `route_fenced`；把唯一 child 收敛到完整 files before/after；据 child 终态构造或丢弃唯一数据库 candidate；验证共同 after；最后写 `activation_intent` 并原子发布为 `activated`。父子 ID/digest/generation 不一致、多个 child 或数据库 candidate 不唯一都进入 `RECOVERY_REQUIRED`。
- [ ] 对 `migration_reserved`、`route_fenced`、`source_snapshot_ready`、`files_candidate_ready`、`file_publication_started`、`files_published`、`database_candidate_ready`、`activation_intent`、`activated` 以及 `migration_abort_intent → migration_aborted` 的每个阶段前后强杀，并覆盖四级目录每次 mkdir/re-canonicalize/fsync/parent-fsync 前后；恢复逐项复核 frozen identity/ownership，幂等复用同一 migration ID/UID/目录/child，不创建第二目录或第二 child。测试明确拒绝 `lifecycle_ready`、`directories_ready`、`completed` 或其他替代状态，并只向 Task 14B 暴露这一套 service。
- [ ] 只有 `activated` 或 `migration_aborted` 才是 MigrationJournal 终态；分别满足规范的 route/target/children/cleanup/reference 谓词后才能进入 L1 bounded GC。aborted reservation 回收后只保留 CSPRNG 概率保证，不宣称全局永久不复用。这里只实现 service/journal；CLI 与 REST/API 的同一 service 接线在 Task 14B，不能在本任务建立第二套状态机。
- [ ] 运行并提交：

```powershell
bun test server/tests/manuscript-schema-12.test.js server/tests/durability-schema.test.js
bun test --test-name-pattern "schema 12|transition proof|manuscript project_meta" server/tests/native-project-store.test.js server/tests/native-project-store-crash.test.js
bun test --timeout 120000 server/tests/manuscript-uid-reservation.test.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-migration.test.js server/tests/manuscript-migration-crash.test.js
git diff --check
git add server/native/durability-schema.js server/native/native-project-store.js server/native/native-sql-authorization.js server/testing/native-stage-b-fixture.js server/testing/native-stage-b-store.js server/db.js server/manuscript-sql-guard.js server/manuscript/uid-reservation.js server/manuscript/migration-journal.js server/manuscript/migration-service.js server/manuscript-service.js server/tests/durability-schema.test.js server/tests/manuscript-schema-12.test.js server/tests/native-project-store.test.js server/tests/native-project-store-crash.test.js server/tests/manuscript-uid-reservation.test.js server/tests/manuscript-service-l2.test.js server/tests/manuscript-migration.test.js server/tests/manuscript-migration-crash.test.js server/tests/fixtures/manuscript-migration-crash.js
git commit -m "feat: migrate projects to file authority"
```

---

## Task 13: 实现 files 新项目的 ProjectCreationJournal

**Depends on:** Task 12。

**Files:**

- Create: `server/manuscript/project-creation-journal.js`
- Create: `server/manuscript/project-creation-service.js`
- Modify: `server/manuscript/uid-reservation.js`
- Modify: `server/db.js`
- Modify: `server/recent-projects.js`
- Create: `server/tests/project-creation-journal.test.js`
- Create: `server/tests/project-creation-crash.test.js`
- Modify: `server/tests/manuscript-uid-reservation.test.js`
- Create: `server/tests/fixtures/project-creation-crash.js`

**State model:**

```text
creation_reserved → project_control_ready → files_published
→ database_candidate_ready → activation_intent → activated → listed → completed

before activation_intent: creation_abort_intent → creation_aborted
unprovable state: RECOVERY_REQUIRED
```

- [ ] parent journal 固定在 `<data>/control/project-creation/<creation_id>/`，位于目标 DB、ControlStore、lifecycle lock 和文章根之外。
- [ ] `ProjectCreationService` 必须注入并调用 Task 7 建立、Task 12 扩展的同一个 `ManuscriptUidReservation`；在 registry/config lease 下，由共享服务扫描 registry、全部现存 roots、全部未 GC ProjectCreationJournal project reservations 与全部注册项目 ControlStore 中未 GC MigrationJournal project reservations。任一来源枚举不完整即在 journal/目录副作用前 fail-closed。
- [ ] 共享 reservation 服务冻结 project UID、四个目标路径/身份及 absent 谓词；同一 creation ID 重试复用 UID，落盘前碰撞可重抽，落盘后碰撞只返回 `UID_RESERVATION_COLLISION`。不得在 ProjectCreationService 内实现第二套随机、扫描或碰撞逻辑。
- [ ] `creation_reserved` 在任何 `mkdir` 前逐级冻结目标 ControlStore、数据库、sibling lifecycle lock、文章根及 `<project_uid>/mythpen/{volumes,chapters}` 的 canonical before/after identity、父身份、absent/owned 谓词和本 creation ID 所有权。parent 在既有 `project_control_ready` 动作中创建项目 ControlStore、不可变身份、sibling lifecycle lock 和四级文章目录，逐项重新 canonicalize，fsync 文件、每个新目录与父目录；不新增规范外状态，Task 8 adapter 仍只用 `OPEN_EXISTING`。
- [ ] 创建初始 `manuscript.json`/`unassigned.json` 空数组，由带 `parent_creation_id` 的 child file journal 发布到 parent 已建立且身份匹配的目录；child 不得创建或接管目录。
- [ ] 以 `sourceKind = empty` 调用 Task 12 的同一个 schema 12 candidate builder，构造唯一空投影 candidate，route 出生即 `files`，全程不出现 `migrating`；不得复制 DDL、trigger、digest、inspector 或另建 empty-candidate generator。`database_candidate_ready → activation_intent → activated` 使用同一 verifier 的 `new_creation` kind，绑定 empty-before/after-v2 digest、project instance、commit seq、candidate identity 与 creation ID；activation intent 后原子发布，重启 admission 不接受 live schema 自证。
- [ ] 激活后才写 config route cache/recent list；崩溃在 activated/listed 之间由应用级 journal 补列，不能创建第二个项目。
- [ ] 启动时在开放项目列表/创建入口前恢复所有非终结 creation journals。
- [ ] activation intent 前只有逐项证明本 creation ID 所有权、child 完整 before、每个 owned 目录没有外部/未知内容且无未知句柄时，parent 才能自内向外删除目标文件与 owned 目录并逐级 fsync；before 已存在项不删，任一身份/所有权/内容不可证明时 `RECOVERY_REQUIRED`。父 journal 本身不得删除；之后只能前滚或 recovery required。
- [ ] 九个步骤前后强杀，并覆盖四级目录每次 mkdir/re-canonicalize/fsync/parent-fsync 前后；恢复逐项复核 frozen identity/ownership，幂等复用同一 creation ID/UID/目录/child，不创建第二目录或接管外部目录。断言普通 files session/direct feed 只在 completed after 成立后建立。共享 reservation tests 注入普通项目创建、migration 与另一 ProjectCreationJournal 的三方碰撞，并覆盖任一注册 ControlStore/creation journal 枚举失败时零副作用拒绝。
- [ ] 运行并提交：

```powershell
bun test --timeout 120000 server/tests/project-creation-journal.test.js server/tests/project-creation-crash.test.js server/tests/manuscript-uid-reservation.test.js server/tests/project-db-existence.test.js
git diff --check
git add server/manuscript/project-creation-journal.js server/manuscript/project-creation-service.js server/manuscript/uid-reservation.js server/db.js server/recent-projects.js server/tests/project-creation-journal.test.js server/tests/project-creation-crash.test.js server/tests/manuscript-uid-reservation.test.js server/tests/fixtures/project-creation-crash.js
git commit -m "feat: create file-authority projects recoverably"
```

---

## Task 14: 实现退役、重激活和数据根屏障

**Depends on:** Task 9B + Task 10 + Task 11 + Task 12 + Task 13。

**Files:**

- Create: `server/manuscript/retirement-service.js`
- Create: `server/manuscript/data-root-guard.js`
- Modify: `server/manuscript/session-controller.js`
- Create: `server/tests/manuscript-retirement.test.js`
- Create: `server/tests/manuscript-data-root-guard.test.js`

- [ ] files 项目进入旧物理删除接口时，在删除 DB/封面/目录之前返回 `PROJECT_PERMANENT_DELETE_UNSUPPORTED`；sqlite 项目保持旧删除行为。
- [ ] 退役锁序固定：registry/config 下 controller→retiring → 释放 lease → 无锁排空已 admission 请求 → 重取 registry/config 并复核 → writer → 拆 feed/关 session/放 shared → 非阻塞 exclusive → route/cache CAS。
- [ ] 确定性交错把请求停在 admission 后、registry/config 前与 writer 前，退役必须让已 admission 请求完成，不能持 registry/config/writer 等待它。
- [ ] 其他进程仍有 shared session 时 exclusive 返回 `PROJECT_WRITE_BUSY` 且 route/cache 零变化；失败后本进程 controller 恢复可用状态。
- [ ] 重激活在 exclusive 下 CAS `retired→files`；首会话重新 shared/recheck/feed/full validation，不复用旧 clean、buffer、counter。
- [ ] retired 不进入普通列表/路由，不持 feed/shared handle；专用列表可重激活，所有资产原位保留。
- [ ] 只要存在 files/migrating/retired 或非终结 creation journal，数据根设置/迁移在创建目录或复制前返回 `NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED`。
- [ ] 创建、迁移、设置数据根三个入口检测 OneDrive/iCloud/reparse 并提供替代位置引导。
- [ ] 本任务只实现可注入的 retirement/data-root backend policy 与 lease 状态机，不修改 API、CLI、项目删除或 storage-migration 产品入口；这些入口在 Task 14B 一次性接线，避免在 Task 10–14 完成前暴露半套行为。
- [ ] 运行并提交：

```powershell
bun test --timeout 60000 server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js
git diff --check
git add server/manuscript/retirement-service.js server/manuscript/data-root-guard.js server/manuscript/session-controller.js server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js
git commit -m "feat: retire file-authority projects safely"
```

---

## Task 14B: 最终接线产品 API、CLI、读写入口与恢复动作

**Depends on:** Task 9B + Task 10 + Task 11 + Task 12 + Task 13 + Task 14。只有这些任务的 backend/journal 合同完成后才能开始；这是 `files` route 首次可达真实 DraftConflictJournal、ignored 出口、迁移、创建与退役行为的唯一接线点。

**Files:**

- Modify: `server/routes/api.js`
- Modify: `server/tools.js`
- Modify: `server/project-export.js`
- Modify: `server/index.js`
- Modify: `server/cli.js`
- Modify: `server/ai-continue-save.js`
- Modify: `server/chapter-revisions.js`
- Modify: `server/manuscript-service.js`
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
- Create: `server/tests/manuscript-product-routing.test.js`
- Create: `server/tests/manuscript-recovery-api.test.js`
- Create: `tests/manuscriptMigrationAdmission.test.ts`

- [ ] 为正文、标题、大纲、状态、摘要、五个叙事字段、卷创建/改名/移动/重排/删除分别写 route/tool 失败测试，断言 `files` route 不执行文章真值 SQL 直写；REST、自动保存、AI 工具、续写和提案接受统一调用 Task 9B 写 turn。
- [ ] 最终写 turn 固定为 Task 8 session admission → writer lease → Task 9 `ensureProjectionCurrent()` → Task 11 基于完整 dirty registry 的真实 conflict gate → Task 7 `execute()`；任何前置失败不得创建 FilePublicationJournal candidate。`sqlite` 继续走 L1，`migrating` 返回 `PROJECT_MIGRATION_BUSY`，`retired` 拒绝普通入口。
- [ ] 列表、详情、导出、统计、角色关联、AI 上下文和只读工具统一走 Task 9B readable wrapper + ActiveManuscriptProjection；消除产品路径 tombstone、旧 generation 和 `MAX(num)` 读取。
- [ ] API 完整接线 Task 10 四个动作：就地忽略、撤销忽略、保留并转为未分卷、解除不透明引用；请求只接受规范 UID/动作枚举，不接受路径，响应返回 generation/ledger 状态。API 集成测试逐字节证明四条路径都不移动或删除用户资源 bytes。
- [ ] API/CLI 调用 Task 12 同一个 MigrationService；项目创建调用 Task 13 ProjectCreationService；旧物理删除、退役/重激活和数据根入口调用 Task 14 policy。不得在 route/CLI 内复制 journal 状态机、UID reservation、目录创建或锁文件创建逻辑。
- [ ] 建立 host-only migration admission seam `beginMigrationAfterHostPreflight(frozenSnapshot, request)`：只接受同一 project/window set 的不可变 snapshot 且每个 dirty resource 均为 `persisted | explicitly_resolved`、全部 save queue 已 `cancelled_and_drained`、所有窗口均已响应；否则在调用 migration API 之前 fail-closed。服务端 route 明确不能独立验证 host dirty registry，也不得把“收到 API 请求”误写成 host preflight 证明；它只在 host seam 真正发起请求后调用 Task 12 service。
- [ ] call-order integration test 用可观察 fake host admission、真实 route/MigrationService fixture 与目录字节快照证明：freeze 未完成、任一 dirty resource 未解决、save queue 未 drain、snapshot/window set 改变或任一窗口无响应时，migration API/MigrationService 调用次数为 0，`migration_reserved`、route/project DB、ControlStore 和全部目标路径 bytes/存在性逐字节不变；只有完整 resolved snapshot 可恰好调用一次。Task 15 的 coordinator 必须调用这一 seam，不得直接调用 route。
- [ ] API 完整接线 Task 11 冲突列表、backup 复制、`accept_external`、`apply_saved_draft` 与 stale/epoch 结果；只有 `backup_durable` 后可对客户端声明 backup 可用，迟到 epoch 永久拒绝。
- [ ] 在本任务第一次建立完整静态扫描 RED：文章真值 SQL/受控文件直写、caller-supplied controlled path、跳过 freshness 的活跃读取、tombstone 读取、章节/卷物理 DELETE、`MAX(num)` 分配/overdue 与 `expected_resolve_chapter` 旧语义逐类使用最小 fixture 失败；随后把全部产品文件纳入同一扫描，删除 API/tools 六条物理 DELETE 并消除其余旧语义，最终扫描必须零债务。全程不建立临时、逐项、目录级或整文件 allowlist；只有持有精确内部 capability 的 schema/projection/recovery 语句由结构化 owner 规则排除。
- [ ] 两进程与请求乱序测试证明 session/writer/freshness/conflict 的释放顺序稳定，失败、取消和 stale response 不清 dirty/conflict evidence；migration/creation/retirement 尚未终结时产品入口 fail-closed。
- [ ] 运行并提交：

```powershell
bun test --timeout 120000 server/tests/manuscript-product-routing.test.js server/tests/manuscript-recovery-api.test.js server/tests/chapter-update-api.test.js server/tests/chapter-tools-identity.test.js server/tests/project-export.test.js server/tests/project-delete-api.test.js server/tests/storage-migration.test.js server/tests/cli.test.js
node --test --test-concurrency=1 tests/manuscriptMigrationAdmission.test.ts
node --test scripts/tests/manuscript-write-scan.test.mjs
pnpm test:contracts
git diff --check
git add server/routes/api.js server/tools.js server/project-export.js server/index.js server/cli.js server/ai-continue-save.js server/chapter-revisions.js server/manuscript-service.js server/storage-migration.js server/recent-projects.js server/manuscript-sql-guard.js scripts/manuscript-write-scan.mjs scripts/tests/manuscript-write-scan.test.mjs src/lib/manuscriptMigrationAdmission.ts server/tests/chapter-update-api.test.js server/tests/chapter-tools-identity.test.js server/tests/project-export.test.js server/tests/project-delete-api.test.js server/tests/storage-migration.test.js server/tests/cli.test.js server/tests/manuscript-product-routing.test.js server/tests/manuscript-recovery-api.test.js tests/manuscriptMigrationAdmission.test.ts
git commit -m "refactor: route manuscript products through complete L2 gates"
```

---

## Task 15: 交付恢复 UI、容量/降级状态与宿主文件入口

**Depends on:** Task 14B。

**Files:**

- Create: `src/lib/manuscriptRoute.ts`
- Create: `src/lib/manuscriptMigrationPreflight.ts`
- Create: `src/lib/manuscriptMigrationPreflightSmoke.ts`
- Modify: `src/lib/dirtyResourceRegistry.ts`
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
- [ ] 实现显式 host migration-preflight coordinator，并让“立即升级”成为它的唯一入口。coordinator 在显示/启用最终确认前冻结 Task 11 的全部 dirty 域（已加载/已卸载正文、sidecar、卷 metadata、结构队列）以及精确 multi-window ID/epoch snapshot，阻止新 save admission，取消或排空每个 debounce/unloaded/window save queue，并要求每份 draft 已耐久保存或由用户逐项显式解决。任何资源/window/queue epoch 在冻结后变化都使 snapshot stale，必须重新开始；不得把 host-only registry 交给 server 猜测。
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
node --test --test-concurrency=1 tests/manuscriptRoute.test.ts tests/manuscriptRecoveryUi.test.ts tests/manuscriptConflicts.test.ts tests/manuscriptMarkdownReadonly.test.ts tests/manuscriptMigrationPreflight.test.ts
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
git add src/lib/manuscriptRoute.ts src/lib/manuscriptMigrationPreflight.ts src/lib/manuscriptMigrationPreflightSmoke.ts src/lib/dirtyResourceRegistry.ts src/components/ManuscriptStatusBanner.tsx src/components/ManuscriptMigrationDialog.tsx src/components/DraftConflictDialog.tsx src/components/OrphanResourceDialog.tsx src/components/RetiredProjectsDialog.tsx src/pages/ProjectList.tsx src/pages/Outline.tsx src/pages/Writing.tsx src/pages/ExportPage.tsx src/stores/useEditorStore.ts src/stores/useChapterStore.ts src/stores/useProjectStore.ts src/i18n/zh.json src/i18n/en.json src-tauri/src/manuscript_files.rs src-tauri/src/lib.rs src-tauri/tests/manuscript_files_integration.rs scripts/tests/desktop-manuscript-files-smoke.ps1 scripts/tests/desktop-manuscript-migration-preflight-smoke.ps1 tests/manuscriptRoute.test.ts tests/manuscriptRecoveryUi.test.ts tests/manuscriptMarkdownReadonly.test.ts tests/manuscriptMigrationPreflight.test.ts
git commit -m "feat: expose file-authority recovery workflows"
```

---

## Task 16: 完成本地正确性 join 与最终验收 harness

**Depends on (explicit join):** Task 2 + Task 3 + Task 4 + Task 5 + Task 6 + Task 7 + Task 8 + Task 9 + Task 9B + Task 10 + Task 11 + Task 12 + Task 13 + Task 14 + Task 14B + Task 15。这里只做 source/local join；不冻结 production source，不运行 VM，不发布 manifest/candidate/result/attestation。

**Files:**

- Create: `server/tests/l2-correctness-matrix.test.js`
- Create: `server/tests/l2-two-process-matrix.test.js`
- Create: `server/tests/l2-capacity-boundary.test.js`
- Create: `server/tests/l2-performance-benchmark.test.js`
- Create: `server/tests/fixtures/create-l2-benchmark-project.js`

- [ ] 汇总规范 15.1–15.7 为逐行可追踪矩阵，记录 test ID、命令、产物、退出码和结论，不使用“同类情况已覆盖”。格式/安全矩阵覆盖 case alias、reparse、hard link、未知文件、journal candidate、孤儿、外部 UID 四出口、容量边界/超限和外部连续改写；Markdown 专项覆盖精确可视方言每一构造、合法 out-of-dialect UTF-8 只读透传、元数据写仍成功、自动保存/AI/提案等语义正文写拒绝、U+0000 投影 content 置空但 raw hash/word count/generation 正确，以及 Task 15 UI 只读状态。
- [ ] DDL/投影矩阵覆盖 ID/sequence 保留、tombstone/复活、两阶段 position、部分唯一索引、overdue、schema/digest 三方检查和 schema too new 零修改；普通 publication、draft conflict、migration、creation 的每个指定阶段前后都做强杀并核对完整 before/after。migration acceptance 必须由 Task 15 的 `desktop-manuscript-migration-preflight-smoke.ps1` 驱动 fresh compiled debug host，实际经过 coordinator/admission/route 链运行固定 7 负 + 1 正 matrix，证明负例 seam/API 未调用且 reservation/route/ControlStore/target bytes 不变、全部 resolved 后只允许一次迁移；source-only client test 或泛称“compiled host”不能替代这个命令。
- [ ] 两进程矩阵运行 writer/refresh/session/retire 竞争，验证 lease 顺序、false-clean 不变量、强杀释放与 admission 后 route/identity 复核。容量矩阵用 10,000 章节身份、2,000 卷身份、25,000 文件、20,000 chapter dir entries、16 MiB md、256 KiB json、1 GiB 累计边界 fixture，并读取 Task 3 observer/counter seam，逐维证明第一次超限后枚举数、身份 probe 数和内容打开数不再增长；超限现场不读全树、不清 dirty、不改外部字节。
- [ ] 冻结两个不可缩小的**本地** fixture（3,000 章/30–40 MiB 与 10,000 章/1 GiB），记录 seed、文件数、字节数和 manifest hash；Task 16 只验证 fixture/harness 的确定性、容量短路和 correctness case 集，不构建或接纳 production artifact。
- [ ] 在源码态跑一次本地 join；全部通过后只提交 correctness/performance harness 与 fixture。此提交不是 production evidence source freeze：

```powershell
pnpm test:server
pnpm test:contracts
pnpm test:client
pnpm typecheck
pnpm exec biome check src/
pnpm build
git diff --check
git add server/tests/l2-correctness-matrix.test.js server/tests/l2-two-process-matrix.test.js server/tests/l2-capacity-boundary.test.js server/tests/l2-performance-benchmark.test.js server/tests/fixtures/create-l2-benchmark-project.js
git commit -m "test: join L2 local correctness"
git status --short
```

**Stop condition:** 任一本地 correctness、容量、两进程、compiled debug-host harness 或完整源码回归失败时停止并修复；不得把 Task 16 的源码态/fixture 结果称为 production evidence，也不得在本任务运行 13/19 VM 矩阵或构建 production candidate。

---

## Task 17A: 做最小性能 preflight 并决定默认路由

**Files:**

- Create: `docs/superpowers/plans/l2-performance-preflight.md`

- [ ] 使用 Task 16 已冻结的 3,000 章与 10,000 章/1 GiB fixture，在本机编译 sidecar/debug desktop 上做开发期 preflight；测量章节列表/侧栏、自动保存 E2E、L2 文件侧增量，以及启动完全校验和显式完全刷新。记录全部样本、nearest-rank p50/p95/max、CPU/磁盘、冷/热缓存和安全软件状态；不生成 production manifest/candidate/attestation，也不把结果称为最终验收。
- [ ] 默认路由的 go/no-go 仍使用三项既定目标：列表/侧栏 p95 `<150 ms`、自动保存 E2E p95 `<300 ms`、L2 文件侧增量 p95 `<120 ms`；启动完全校验与显式刷新还必须在两个 fixture 上完成校准，且 UI 线程外执行、有可见进度、刷新可取消。任何一项无把握时选择 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，继续 sqlite 默认；不得缩小 fixture、降低样本数、删慢样本或放宽阈值。
- [ ] preflight 命令只消费源码态/本地编译产物：

```powershell
pnpm build:sidecar
bun test --timeout 600000 server/tests/l2-performance-benchmark.test.js
```

- [ ] 只把 preflight 数字、运行条件和默认路由决定写入文档；若需要优化生产代码，先提交优化并重跑 Task 16 本地 join 与本任务。所有 production source 和默认路由决定稳定后才进入 Task 17B：

```powershell
git diff --check
git add docs/superpowers/plans/l2-performance-preflight.md
git commit -m "docs: record L2 performance preflight"
```

---

## Task 17B: 切换默认路由并验收最终 production artifact

**Files:**

- Modify: `server/build-info.js`
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

- [ ] 只有 Task 17A 全部性能门禁通过，才将 production 状态设为 `DEFAULT_READY`，让普通新项目默认创建 files，并向 sqlite 项目显示默认迁移入口；显式回退开关只选择新建路由，不建立双写或 migrated 项目的 sqlite-authoritative 回退。
- [ ] 先以 source tests 固定 default route、explicit sqlite opt-out、迁移延期和无双写语义；跑完整回归并提交唯一的默认路由产品代码 checkpoint：

```powershell
bun test server/tests/project-creation-journal.test.js
node --test --test-concurrency=1 tests/manuscriptRoute.test.ts
pnpm test:server
pnpm test:contracts
pnpm test:client
pnpm typecheck
pnpm exec biome check src/
pnpm build
git diff --check
git add server/build-info.js server/manuscript/project-creation-service.js src/pages/ProjectList.tsx server/tests/project-creation-journal.test.js tests/manuscriptRoute.test.ts
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

- [ ] 在这个最终 candidate 上依次运行 compiled L1/L2 E2E、L1 native/save benchmark、L2 performance benchmark、完整 server/contracts/client/typecheck/build，以及 fresh debug desktop 的 lifecycle、files 与 migration-preflight smoke。每个进程必须真实退出；Task 17A 样本不能替代最终样本。若默认决定是 deferred，E2E 必须断言 sqlite 仍为默认且显式实验入口可用；若是 default-ready，则断言 files 默认与显式 sqlite opt-out：

```powershell
$env:MYTHPEN_L1_PRODUCTION_CANDIDATE = $finalCandidatePath
$env:MYTHPEN_L1_REVIEWED_MANIFEST = $finalL1ManifestPath
node --test scripts/tests/l1-production-e2e.test.mjs
node --test scripts/tests/l2-production-e2e.test.mjs
bun test --timeout 600000 server/tests/native-durability-benchmark.test.js server/tests/l2-performance-benchmark.test.js
Remove-Item Env:MYTHPEN_L1_PRODUCTION_CANDIDATE, Env:MYTHPEN_L1_REVIEWED_MANIFEST -ErrorAction SilentlyContinue
pnpm test:server
pnpm test:contracts
pnpm test:client
pnpm typecheck
pnpm build
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
- [ ] §8 服务边界与全部写入口：Task 4–7、Task 9B wrapper、Task 14B final wiring
- [ ] §9 direct feed、freshness、`OPEN_EXISTING` lifecycle lease 与产品 admission：Task 8–9B、Task 14B
- [ ] §10 FilePublicationJournal 及“只发布到 parent 已建立目录”：Task 6、Task 12–13
- [ ] §11 全资源域草稿冲突、epoch/intent/parent-child/audit/retention：Task 11、Task 14B、Task 15、Task 16
- [ ] §12 host-only dirty-resource preflight、debug-only authenticated compiled-desktop harness、迁移、UID reservation、新建项目、parent 目录所有权：Task 11–13、Task 14B–16、Task 17B
- [ ] §13 退役、重激活、数据根：Task 14、Task 14B、Task 15
- [ ] §14 错误、四个 orphan/external UID 出口、恢复与诊断：Task 2、Task 10–11、Task 14B–15
- [ ] §15 correctness/regression、compiled preflight 的绝对 DesktopPath/SidecarPath/ResultPath 与最终原始日志/退出码/hash 账本：Task 15–17B（Task 16 显式 join Task 2、3、4、5、6、7、8、9、9B、10、11、12、13、14、14B、15）
- [ ] §16 容量立即短路 seams、性能、默认启用：Task 3、Task 10、Task 15–16、Task 17A–17B
- [ ] §17 产品决定：所有任务均保持零 Git、迁移可延期、两级性能状态
