# L1 Durability Stage A Compatibility Foundation Implementation Plan

> 文件名保留历史命名；本计划的当前权威范围是兼容基础与本地验收，不包含
> installer、tag 或 release。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 `nativeActivationMode=off` 完成 Stage A 兼容实现与本地验收，包括 Task 8 用户恢复入口、config 全生命周期互斥、v1 终态加固、写边界、稳定 JSON 错误、桌面单实例/动态 endpoint/nonce 和可确认 shutdown，为后续 native 项目存储消除全部 Stage A 阻塞。installer、tag、release 不是本计划当前交付物，必须另获用户授权。

**Architecture:** `config.db` 与项目库在本阶段继续使用现有 sql.js/SqlJsAtomicStore；新增稳定应用控制根中的 `ConfigLifecycleLease`，新增完全只读的 ControlStore/SqlJsAtomicStore inspector 与薄 `RecoveryDiagnostics` 服务。桌面宿主拥有唯一 sidecar，renderer 只从宿主取得动态 loopback endpoint 与 nonce；退出通过 owned-child stdin/stdout 控制通道驱动服务端状态机，不再依赖端口猜测或 HTTP shutdown。

**Tech Stack:** Bun 1.3.14、CommonJS/Express 5、sql.js、Node test runner、React 19/TypeScript 6/Zustand、Tauri 2/Rust、`tauri-plugin-shell`、`tauri-plugin-single-instance`。

## 实施状态（2026-08-11）

| 范围 | 状态 | 说明 |
|---|---|---|
| Task 1–9 | **已完成** | 代码、聚焦测试、修复与逐任务独立审查完成 |
| Task 10 | **已完成** | 自动化、compiled sidecar、服务端现场、五个 Desktop 生命周期场景、RecoveryNotice E2E 与 slow-drain 合同均已闭环 |
| Stage A 本地验收 | **已完成** | Task 1–10 的代码、编译产物、现场与 UI 证据完成 |
| 兼容版本发布 | **未授权 / 未执行** | installer、tag、release 与发布产物验收不属于当前执行范围，也不是 Stage B/C 前置 |

权威验收账本：`l1-stage-a-acceptance.md`。Task 8 的代码工作、服务端现场
矩阵、五个 Desktop 生命周期场景、真实 RecoveryNotice UI 与 Task 10 最终验收
均已完成；兼容版本发布未获授权，不得把“本地验收完成”写成“已发布”，也不得
因此阻塞 NativeProjectStore/schema 11 的后续实现。

## Task 10 收口结果与独立交付轨

| 卡点 | 性质 | 完成条件 |
|---|---|---|
| RecoveryNotice 真实 UI | **已通过** | 同一真实 Tauri/WebView2/CDP/nonce harness 用 v1 prepared fixture 验证了键盘/focus、迟到刷新取消、`aria-live`、真实 423 busy、刷新、opaque export、双重 ready 恢复与 nonce transport；未另建浏览器 E2E |
| Desktop 五项生命周期 | **已通过** | 精确选择 PID 所属、可见且响应的 `Tauri Window`/`Mythpen` 主窗口；显式受控 loopback CDP 端口与 WebView2 进程祖先链绑定；second-instance、session、normal shutdown、两步 emergency、unowned sentinel 全部 PASS |
| `slow_drain_cancel` | **已按结构性合同闭环** | 生产扫描为 `asyncAdmissions=[]`，9 个生产 admission 全是同步入口；构建合同在未来出现异步入口时失败，协调器 48/48 覆盖异步 drain/cancel/stale continuation；未增加 production runtime test hook |
| 兼容版本发布 | **独立待授权交付轨** | 只有完整 L1 候选达到发布状态且用户明确授权时，才对冻结候选执行 installer smoke、摘要、tag、release 和发布后 smoke |

执行顺序：Desktop CDP attach、五项矩阵、同一 harness 的 RecoveryNotice E2E 与
`slow_drain_cancel` 门禁裁决均已完成。本计划到此收口；当前开发主线直接进入
NativeProjectStore、schema 11 与性能重构。installer、tag、release 保持未执行，
等待完整 L1 候选成熟后的单独授权。

## Global Constraints

- 本计划只实现设计稿阶段 A；不得实现 NativeProjectStore、schema 11、checkpoint、native transaction、fixture activation 或 production activation。
- 不引入 bridge、cohort、readiness、signed entitlement、path rebind、data-root import 或未注册 bundle 入口。
- 编译期 `nativeActivationMode` 固定为 `off`；HTTP、CLI、环境变量或 marker 均不能切换到其他模式。
- Task 8 只接受已注册项目名称，固定使用 `/api/projects/by-name/:name/diagnostics...`；不得接受客户端路径、文件名、`importId` 或 bundle locator。
- diagnostics GET 必须字节级零副作用：不得 mkdir、创建 lock/temp/incarnation、recover、checkpoint、SQLite journal 或 event。
- Stage A 保留 `recover_transaction`、`recover_v1_publication`、`adopt_same_path_identity` 三个协议 action；只执行 `recover_v1_publication`。另两项稳定返回禁用，不伪造 native/adoption 证据。
- 所有非 SSE 错误统一为 `{ error: { code, message, recoverable } }`；未知异常不得返回 HTML、原始 message、stack 或绝对路径。
- 单个坏项目只能隔离该项目；config/data-root/ConfigLifecycleLease 的全局失败才阻止监听。
- 每一任务先写 RED、确认失败原因正确，再写最小实现；每任务独立提交，禁止把后续阶段代码混入。
- 全量验收仍使用 `pnpm test:server`、`pnpm test:client`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、Rust tests 和编译 sidecar smoke。

---

### Task 1: ConfigLifecycleLease 与 data-root 零副作用门禁

**Files:**

- Create: `server/application-control-paths.js`
- Create: `server/config-lifecycle-lease.js`
- Create: `server/tests/config-lifecycle-lease.test.js`
- Create: `server/tests/fixtures/config-lifecycle-holder.js`
- Modify: `server/db.js`
- Modify: `server/cli.js`
- Modify: `server/storage-migration.js`
- Modify: `server/tests/storage-reconfiguration.test.js`
- Modify: `server/tests/cli.test.js`

**Interfaces:**

- Consumes: `resolveStoragePaths()`、`canonicalDatabasePath()`、`acquireExclusiveLease()` 与现有 `storageFailure` fence。
- Produces: `resolveStableApplicationControlRoot()`、`acquireConfigLifecycleLease()`、`acquireConfigLifecycleLeaseSet()`、`db.closeAllDatabases()`。
- `ConfigLifecycleLease` 从 `_openConfig()` 之前持有到 config wrapper、AtomicStore、guard 均确认关闭之后；释放失败进入 `disposition_unknown`，进程内不得重取。

- [x] **Step 1: 写单/双进程 RED**

新增测试覆盖：同一 `config.db` 第二持有者得到 `CONFIG_DATABASE_BUSY`；首进程强杀后可重取；不同 data root 可独立持有；source/target lease 按 canonical config path digest 排序，避免换根死锁。

关键断言：

```js
assert.throws(
  () => acquireConfigLifecycleLease(configDbPath),
  (error) => error.code === 'CONFIG_DATABASE_BUSY' && error.status === 423,
);
```

- [x] **Step 2: 运行聚焦测试并确认模块缺失**

Run: `bun test ./server/tests/config-lifecycle-lease.test.js`

Expected: FAIL，首个失败是 `server/config-lifecycle-lease.js` 不存在，而不是 fixture 或权限错误。

- [x] **Step 3: 实现稳定控制根与 lease 对象**

`application-control-paths.js` 的生产根不跟随 data root；测试通过显式 `homeDir` 注入：

```js
function resolveStableApplicationControlRoot({ homeDir = os.homedir() } = {}) {
  return path.join(path.resolve(homeDir), '.mythpen-control');
}
```

`config-lifecycle-lease.js` 至少暴露：

```js
function acquireConfigLifecycleLease(configDbPath, options = {}) {
  // canonical config path -> sha256 -> stableRoot/config-leases/<digest>.lease
  // LEASE_BUSY -> CONFIG_DATABASE_BUSY
  // return { assertHeld(), release(), state, configDbPath, leasePath }
}

function acquireConfigLifecycleLeaseSet(configDbPaths, options = {}) {
  // 去重后按 canonical path UTF-8 字节序取得；任一失败反序释放已取得 lease。
}
```

释放只在底层 `lease.release()` 成功后把 state 改为 `released`；任何 operational error 先改为 `disposition_unknown` 并抛 `STORAGE_UNAVAILABLE`。

- [x] **Step 4: 接入 config 打开、切换和关闭**

在 `db.js` 中增加单一 `configLifecycleLease` 状态：

```js
async function initDatabase() {
  // load SQL first, then acquire before _openConfig
  configLifecycleLease = acquireConfigLifecycleLease(getStoragePaths().configDbPath);
  try {
    configDb = _openConfig(configLifecycleLease);
  } catch (error) {
    releaseConfigLeaseAfterFailedOpen(error);
    throw error;
  }
}
```

`_openConfig(lease)` 必须把 `lease.assertHeld` 传给 `_createAtomicStore()`。`configureStorage()` 与 `closeAllDatabases()` 固定顺序为：fence admission → close projects → close config → release old lease → publish new paths；close/release unknown 进入现有 `storageFailure`，禁止 query/write/reconfigure。

- [x] **Step 5: 用 lease 替换 CLI 固定端口互斥，并加入 native root preflight**

删除 `isServerRunning(127.0.0.1:3001)` 作为正确性依据。`data-dir set`/`--migrate` 在任何 target mkdir/copy/store.set 之前：

1. 只读扫描 source 中注册的项目；
2. 发现 schema 11 或 `durability_backend=native-sqlite-v2` 时返回 `NATIVE_DATA_ROOT_MIGRATION_UNSUPPORTED`；
3. 同时取得 source/target config lifecycle lease；
4. 才允许已有 v1 迁移逻辑运行。

测试必须比较 source、target 与 path store 的 entry/byte manifest，证明 busy/native 拒绝为零副作用。

- [x] **Step 6: 回归并提交**

Run:

```powershell
bun test ./server/tests/config-lifecycle-lease.test.js
bun test ./server/tests/storage-reconfiguration.test.js ./server/tests/cli.test.js
```

Expected: PASS。

Commit: `feat: guard config database lifecycle`

---

### Task 2: v1 terminal 双重验证与 lease-loss logical fence

**Files:**

- Modify: `server/testing/fault-injection.js`
- Modify: `server/sqljs-atomic-store.js`
- Modify: `server/project-write-coordinator.js`
- Modify: `server/db.js`
- Modify: `server/tests/sqljs-atomic-store.test.js`
- Modify: `server/tests/project-write-coordinator.test.js`

**Interfaces:**

- Consumes: 现有 `readFileSnapshot()`、`predicateMatchesSnapshot()`、publication terminal 与 coordinator lease。
- Produces: `assertSnapshotMatchesPredicate()`、`onLeaseLost(canonicalKey,error)`、wrapper `_fenceForLeaseLoss()`。

- [x] **Step 1: 写 terminal 前后替换 RED**

增加 fault points：

```js
ATOMIC_STORE_PUBLISH_AFTER_TERMINAL_APPEND
ATOMIC_STORE_RECOVER_BEFORE_TERMINAL_APPEND
ATOMIC_STORE_RECOVER_AFTER_TERMINAL_APPEND
```

在 fault callback 中用相同字节替换正式文件以制造新 inode，并分别断言 publish/recover 不得成功安装 epoch，后续 query/write 稳定返回 `RECOVERY_REQUIRED`。

- [x] **Step 2: 运行并确认旧实现错误通过**

Run: `bun test ./server/tests/sqljs-atomic-store.test.js --test-name-pattern "terminal|identity"`

Expected: FAIL，至少一例显示 terminal append 后新 identity 被接受。

- [x] **Step 3: 统一 predicate 复验**

实现：

```js
function assertSnapshotMatchesPredicate(predicate, snapshot, message) {
  if (!predicateMatchesSnapshot(predicate, snapshot)) {
    throw new RecoveryRequiredError(message);
  }
  return snapshot;
}
```

`publish()` 和 `recover()` 均固定执行：构造 final predicate → terminal 前读并精确验证 → append terminal → terminal 后重新读并验证同一 predicate → 用 post-check snapshot 安装新 epoch。删除 recover 的 bytes-only 判定。

- [x] **Step 4: close/release 失败先 fence**

`SqlJsAtomicStore.close()`、wrapper close 与 coordinator release failure 在报告错误前先使相关 connection/queue logical fenced。`createProjectWriteCoordinator()` 接受 `onLeaseLost`，且每个 canonical key 对同一 loss 只通知一次；`db.js` 用它调用缓存 wrapper 的 `_fenceForLeaseLoss(error)`。

- [x] **Step 5: 回归并提交**

Run:

```powershell
bun test ./server/tests/sqljs-atomic-store.test.js
bun test ./server/tests/project-write-coordinator.test.js
```

Expected: PASS。

Commit: `fix: verify v1 terminal state twice`

---

### Task 3: SQL runtime guard 与独立静态扫描

**Files:**

- Modify: `server/manuscript-sql-guard.js`
- Modify: `server/tests/manuscript-service.test.js`
- Create: `scripts/manuscript-write-scan.mjs`
- Create: `scripts/tests/manuscript-write-scan.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `assertManuscriptBodySqlAllowed()` 的现有授权模型。
- Produces: runtime `classifyChapterBodyMutation()` 对无法证明安全的 chapters mutation fail-closed；独立 `scanManuscriptWriteBoundary()` 不导入 runtime classifier。

- [x] **Step 1: 写 row-value 与 columnless INSERT 矩阵**

至少覆盖：

```sql
UPDATE chapters SET (content, title) = (?, ?) WHERE id = ?
UPDATE chapters SET (title, outline) = (?, ?) WHERE id = ?
INSERT INTO chapters VALUES (?, ?, ...)
INSERT INTO chapters (id, title) VALUES (?, ?)
```

第一、第三条必须受保护；第二、第四条可按明确列清单判定不写正文。畸形/CTE/注释/quoted identifier 只要目标是 chapters 且不能证明排除 content，就必须拒绝。

- [x] **Step 2: 证明当前 runtime/static scanner 均不满足**

Run:

```powershell
bun test ./server/tests/manuscript-service.test.js --test-name-pattern "row-value|columnless|static"
node --test scripts/tests/manuscript-write-scan.test.mjs
```

Expected: runtime row-value 测试失败；static 测试证明旧 scanner 依赖 runtime classifier。

- [x] **Step 3: 实现两个独立判定器**

runtime parser 解析 top-level `SET` 左值列表；`UPDATE chapters`、`INSERT/REPLACE INTO chapters` 的未知形状返回 `{ kind: 'unknown-protected-write' }`，绝不返回 null 放行。

tooling scanner 用独立词法/文本实现，只扫描生产 `server/**/*.js`，维护极小明确 allowlist；文件中不得出现 `require('../manuscript-sql-guard')` 或等价 import。

`package.json` 增加：

```json
"test:contracts": "node --test scripts/tests/*.test.mjs && node scripts/manuscript-write-scan.mjs"
```

- [x] **Step 4: 回归并提交**

Run:

```powershell
bun test ./server/tests/manuscript-service.test.js ./server/tests/seed-runtime-guard.test.js
pnpm test:contracts
```

Expected: PASS。

Commit: `fix: close manuscript sql guard gaps`

---

### Task 4: 稳定 JSON error 与 token_usage 副作用隔离

**Files:**

- Create: `server/json-error-middleware.js`
- Create: `server/token-usage-recorder.js`
- Create: `server/tests/json-error-middleware.test.js`
- Create: `server/tests/ai-token-usage-isolation.test.js`
- Modify: `server/index.js`
- Modify: `server/project-instance-middleware.js`

**Interfaces:**

- Produces: `statusForErrorCode(code)`、`jsonErrorMiddleware(error,req,res,next)`、`recordTokenUsageBestEffort(write,logger)`。

- [x] **Step 1: 写错误矩阵与主流程隔离 RED**

覆盖设计稿 §14.6 全部 code/status，以及 JSON parse error、未知 exception、404。未知异常期望：

```js
assert.deepEqual(await response.json(), {
  error: { code: 'INTERNAL_ERROR', message: '服务内部错误', recoverable: false },
});
assert.doesNotMatch(response.headers.get('content-type'), /text\/html/);
```

token_usage mock 抛错时，non-streaming 与 streaming AI 主响应仍按 provider 结果完成。

- [x] **Step 2: 运行 RED**

Run:

```powershell
bun test ./server/tests/json-error-middleware.test.js
bun test ./server/tests/ai-token-usage-isolation.test.js
```

Expected: FAIL，模块不存在；stream chat 的 usage 写异常中断主流程。

- [x] **Step 3: 实现最终 middleware 与单一 best-effort helper**

最终 middleware 必须注册在全部普通路由之后。SSE 已开始写响应时沿现有 SSE error event 结束，不能二次写 JSON header。四个 token usage call site 全部走同一 helper；helper 只记录安全 code，不把正文、provider payload 或 key 写入日志。

- [x] **Step 4: 回归并提交**

Run: `bun test ./server/tests/json-error-middleware.test.js ./server/tests/ai-token-usage-isolation.test.js ./server/tests/ai-adapter-request-parameters.test.js`

Expected: PASS。

Commit: `fix: stabilize api error handling`

---

### Task 5: 只读 inspector、RecoveryDiagnostics 与启动隔离

**Files:**

- Modify: `server/control-store.js`
- Modify: `server/sqljs-atomic-store.js`
- Create: `server/recovery-diagnostics.js`
- Create: `server/tests/recovery-diagnostics.test.js`
- Modify: `server/db.js`
- Modify: `server/recent-projects.js`
- Modify: `server/tests/recent-projects.test.js`
- Modify: `server/tests/project-write-coordinator.test.js`

**Interfaces:**

- Produces: `inspectControlStore(controlDir)`、`inspectSqlJsAtomicStore(...)`、`inspectRegisteredProject(name)`、`recoverRegisteredProject(name,{action,snapshot})`、`projectOpenStates`。
- GET snapshot 是 canonical whitelist DTO 的 SHA-256，不是路径或数据库 hash 的替身。

- [x] **Step 1: 构造三种 v1 现场与零写入 RED**

在 `recovery-diagnostics.test.js` 构造：可前滚、可回滚、第三种字节状态。每次 inspect 前后递归记录 data root 的名称、类型、identity、长度与字节摘要，断言完全一致；特别断言没有新 `.lock`、incarnation、candidate、event 或目录。

- [x] **Step 2: 运行 RED**

Run: `bun test ./server/tests/recovery-diagnostics.test.js`

Expected: FAIL，`server/recovery-diagnostics.js` 不存在。

- [x] **Step 3: 抽出真正只读的 ControlStore/AtomicStore inspector**

`inspectControlStore()` 不调用 `openControlStore()`；只接受已存在的普通目录，执行 directory identity-before → read/validate event chain → identity-after，并返回投影：

```js
{ incarnationId, tail: { seq, digest }, events: [{ seq, type, digest, prevDigest }] }
```

`inspectSqlJsAtomicStore()` 与 `recover()` 共用 `inspectPublicationJournal()` 和 predicate 分类，但不得创建 connection/store、调用 recover 或清理 artifact。

- [x] **Step 4: 实现 RecoveryDiagnostics 白名单 DTO 与 stale snapshot**

DTO 精确字段按设计稿 §14.3。不得输出 SQL、参数、查询结果、正文、原始 event payload、绝对目录或原始 project instance id；实例只输出 SHA-256。

`recoverRegisteredProject()`：先验证 action；取得项目 writer lease；从头 inspect；snapshot 不同返回 `RECOVERY_SNAPSHOT_STALE` 且零写；只有 `recover_v1_publication` 调用现有 store recovery。Stage A 的另外两项返回 `NATIVE_ACTIVATION_DISABLED`。

- [x] **Step 5: 启动逐项目隔离**

用 `inspectProjectDatabasesAtStartup()` 替换当前遇错全局抛出的恢复循环。维护：

```js
Map<canonicalProjectPath, { openState, reasonCode, recommendedAction }>
```

健康项目可以随后正常打开；isolated 项目的 `getProjectDb()` 直接重抛稳定记录，不重复打开。`readRecentProject()` 对 isolated 行不调用 `openProjectDb()`，并在列表 DTO 中包含 `openState/reasonCode/recommendedAction`。

schema 高于 `PROJECT_SCHEMA_VERSION` 必须单独返回 `PROJECT_SCHEMA_TOO_NEW`，而不是 `PROJECT_DATABASE_NOT_PROJECT`。

- [x] **Step 6: 回归并提交**

Run:

```powershell
bun test ./server/tests/recovery-diagnostics.test.js
bun test ./server/tests/recent-projects.test.js ./server/tests/project-write-coordinator.test.js
```

Expected: PASS；一个坏项目与一个健康项目时，结果分别 isolated/ready，进程不退出。

Commit: `feat: add read-only recovery diagnostics`

---

### Task 6: Task 8 固定 API 与 opaque diagnostics export

**Files:**

- Modify: `server/project-export.js`
- Modify: `server/routes/api.js`
- Modify: `server/tests/project-export.test.js`
- Modify: `server/tests/project-route-collision.test.js`
- Create: `server/tests/recovery-diagnostics-api.test.js`

**Interfaces:**

- Produces:
  - `GET /api/projects/by-name/:name/diagnostics`
  - `POST /api/projects/by-name/:name/diagnostics/recover`
  - `POST /api/projects/by-name/:name/diagnostics/export`
  - `publishOpaqueDiagnosticsExport()`

- [x] **Step 1: 写路由、snapshot 与 export RED**

覆盖保留名项目、非法 action、缺失/陈旧 snapshot、客户端注入 `path/fileName/importId`、diagnostics payload 泄漏检查。Export 期望只返回：

```js
{ filename: '<uuid>.mythpen-diagnostics.json' }
```

- [x] **Step 2: 运行 RED**

Run:

```powershell
bun test ./server/tests/recovery-diagnostics-api.test.js
bun test ./server/tests/project-route-collision.test.js ./server/tests/project-export.test.js
```

Expected: FAIL，固定 routes 返回 404。

- [x] **Step 3: 实现薄路由和安全发布**

三个路由使用参数名 `:name`，不得经过会打开项目的 `router.param('project')`。路由只校验 DTO 并调用 RecoveryDiagnostics。

`publishOpaqueDiagnosticsExport()` 在 `db.getExportDir()` 中以 server UUID + `wx` 创建临时文件，fsync 文件与目录后无覆盖发布。JSON 只含 whitelist DTO、平台 capability 和投影 event 摘要；当前 DB SHA-256 只在用户主动 export 时计算，响应不返回绝对路径。

- [x] **Step 4: 回归并提交**

Run: `bun test ./server/tests/recovery-diagnostics-api.test.js ./server/tests/project-route-collision.test.js ./server/tests/project-export.test.js`

Expected: PASS。

Commit: `feat: expose project recovery endpoints`

---

### Task 7: RecoveryNotice、项目隔离 UI 与客户端 API

**Files:**

- Create: `src/components/RecoveryNotice.tsx`
- Create: `src/lib/projectRecovery.ts`
- Create: `tests/recoveryNotice.test.ts`
- Create: `tests/apiProjectDiagnostics.test.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/types/index.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/lib/projectCreationFallback.ts`
- Modify: `src/pages/ProjectList.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/zh.json`
- Modify: `src/i18n/en.json`

**Interfaces:**

- Produces: `ProjectDiagnostics`、`RecoveryAction`、`projectsApi.getDiagnostics/recoverDiagnostics/exportDiagnostics` 与可单测的 recovery controller。

- [x] **Step 1: 写客户端状态机 RED**

覆盖：isolated 项目不请求 phase/chapters；点击只进入 RecoveryNotice；恢复成功重新拉 projects + diagnostics；stale/failure/cancel 保留现场；export 显示 opaque filename；按钮 pending 时禁用；状态说明使用 `aria-live`。

diagnostics helpers 必须使用专用 request，不附加 `X-Mythpen-Project-Instance`，但仍经过 name-scoped request gate。

- [x] **Step 2: 运行 RED**

Run:

```powershell
node --test --test-concurrency=1 tests/apiProjectDiagnostics.test.ts tests/recoveryNotice.test.ts
```

Expected: FAIL，API/组件不存在。

- [x] **Step 3: 扩展安全类型与 API error details**

`ProjectInfo`/summary 增加 `openState`、`reasonCode`、`recommendedAction`。`ApiError` 只保留 server 提供的安全结构化 details，不存原始 response body。

- [x] **Step 4: 接入 store/App/ProjectList 隔离门**

`loadProjects()` 默认 current project 只能从 `openState==='ready'` 项目中选择；isolated 项目不触发 phase/chapters。ProjectList 卡片显示状态，禁用删除，点击选择 recovery target。App 对该 target 只挂载 RecoveryNotice，不挂载 Sidebar、editor 或 AI panel。

- [x] **Step 5: 实现 RecoveryNotice 与中英文文案**

显示本地化 reason、自动恢复、诊断导出、返回列表和“不要删除/覆盖现场”。Stage A 不显示可用 adoption 确认；若 server 返回 `canAdoptIdentity=false`，按钮不得渲染。

- [x] **Step 6: 回归并提交**

Run:

```powershell
pnpm test:client
pnpm typecheck
pnpm lint
```

Expected: PASS。

Commit: `feat: add project recovery notice`

---

### Task 8: sidecar 动态 endpoint、nonce/build.info 与 shutdown 状态机

**Files:**

- Create: `server/build-info.js`
- Create: `server/sidecar-control.js`
- Create: `server/service-lifecycle.js`
- Create: `server/server-runtime.js`
- Create: `server/tests/sidecar-control.test.js`
- Create: `server/tests/shutdown-coordinator.test.js`
- Modify: `server/project-write-coordinator.js`
- Modify: `server/db.js`
- Modify: `server/index.js`
- Modify: `scripts/build-sidecars.mjs`
- Modify: `scripts/tests/build-sidecars.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: ConfigLifecycleLease、coordinator lease-loss fence、`db.closeAllDatabases()`。
- Produces: newline-delimited authenticated control frames；`ready`/`build.info`；`running → quiescing → draining → closing → complete|failed`。

- [x] **Step 1: 写 nonce/control/build-info RED**

覆盖：`PORT=0` 只绑定 `127.0.0.1`；ready 返回实际端口、childPid、nonce digest、`off`、完整 source commit 与 target triple；错 nonce business request/control frame 拒绝；普通 HTTP `/api/shutdown` 为 404；无 stdout heartbeat 不触发自动 kill。

- [x] **Step 2: 写 shutdown RED**

覆盖 quiescing 后 mutation 得到 `SERVICE_SHUTTING_DOWN`，已排队项继续；drain 等到 terminal；closing 前 cancel 恢复 admission 与新 service epoch；closing 后 cancel 拒绝；close/release unknown 进入 failed；正常 complete 后才退出。

- [x] **Step 3: 运行 RED**

Run:

```powershell
bun test ./server/tests/sidecar-control.test.js
bun test ./server/tests/shutdown-coordinator.test.js
node --test scripts/tests/build-sidecars.test.mjs
```

Expected: FAIL，控制模块不存在且 server 仍暴露 HTTP shutdown。

- [x] **Step 4: 实现编译期 build info**

`build-info.js` 中 activation mode 是字面量 `off`；构建脚本只注入 source commit/target triple，不能从 runtime env 改 mode。`build-sidecars.mjs` 在 Bun compile 时定义完整 commit/triple，并让 smoke 读取 `build.info` 验证目标包。

- [x] **Step 5: 实现 sidecar bootstrap、控制通道与 nonce middleware**

Tauri 只通过 child env 传 `MYTHPEN_DESKTOP_OWNED=1` 和 `PORT=0`，再以首条 stdin bootstrap frame 传 256-bit nonce；nonce 不出现在 argv、environment 或日志。desktop-owned sidecar 在验证 bootstrap 前不得取得 ConfigLifecycleLease、打开 config 或监听。stdout control frame 只返回 nonce digest。renderer 的每个 `/api` 请求携带 `X-Mythpen-Instance-Nonce`；直接 browser dev 未设置 desktop-owned marker 时保持 `/api` proxy 开发模式。

把 `index.js` 的 app/listen 启动拆到可测试的 `server-runtime.js`；listen 必须显式使用 `127.0.0.1` 与严格解析的端口 0。health/ready 只能在 config 初始化和逐项目只读检查完成后发布。

- [x] **Step 6: 实现可取消 shutdown**

`ProjectWriteCoordinator` 增加 `beginQuiesce()`、`cancelQuiesce()`、`drain()`；`service-lifecycle.js` 管 admission、attemptSeq、serviceEpoch 和状态转换。quiescing/draining 保持 listener 绑定；取消必须恢复 admission、延迟 timer 和新的 service epoch，只有 closing 才关闭 listener。删除 5 秒自动强退及 HTTP shutdown。stdin command 只允许当前 nonce/attemptSeq。

`shutdown.complete` 必须精确包含 `{ childPid, attemptSeq, outcome: 'clean' }`；close/release unknown 只能产生 `shutdown.failed`。正常 shutdown 不计算整库 hash、不创建或强制触发 checkpoint。无 heartbeat 只允许触发 soft-deadline UI，不能自动判死或 kill。

- [x] **Step 7: 回归并提交**

Run:

```powershell
bun test ./server/tests/sidecar-control.test.js ./server/tests/shutdown-coordinator.test.js
node --test scripts/tests/build-sidecars.test.mjs
pnpm build:sidecar
```

Expected: PASS，编译 sidecar 的 authenticated `build.info` 报告 `off`。

Commit: `feat: add owned sidecar control channel`

---

### Task 9: Tauri 单实例、renderer session 与可确认退出

**Files:**

- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/src/desktop_instance.rs`
- Create: `src-tauri/src/sidecar_protocol.rs`
- Create: `src-tauri/src/shutdown.rs`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/lib/backendRuntime.ts`
- Create: `src/lib/shutdownUiState.ts`
- Create: `src/components/ShutdownDialog.tsx`
- Create: `tests/backendRuntime.test.ts`
- Create: `tests/apiNonceTransport.test.ts`
- Create: `tests/shutdownUiState.test.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/projectExport.ts`
- Modify: `src/components/ServerStatusGate.tsx`
- Modify: `src/components/BottomStatusbar.tsx`
- Modify: `src/components/SettingsDrawer.tsx`
- Modify: `src/main.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/zh.json`
- Modify: `src/i18n/en.json`
- Create: `scripts/tests/desktop-lifecycle-smoke.ps1`

**Interfaces:**

- Produces Tauri commands: `get_sidecar_session`、`request_shutdown`、`cancel_shutdown`、`continue_shutdown_wait`、`emergency_exit`。
- `SidecarSession` 只在内存保存 `{port,nonce,childPid,buildInfo}`；第二实例只聚焦已有窗口。

- [x] **Step 1: 写 host reducer/session/transport RED**

Rust unit tests覆盖 bootstrap/ready frame 解析、wrong nonce digest、child termination、attemptSeq 与 owned-child 判定。TS tests 覆盖 runtime 未初始化不得构造固定 3001 URL、JSON/SSE/blob 请求全部注入 nonce，以及 soft deadline UI 的继续/取消/emergency 分支。

- [x] **Step 2: 消除双 server 与 renderer spawn 权限**

`tauri.conf.json` 的 `beforeDevCommand` 改为只启动 Vite（保留 `pnpm dev:all` 给 browser dev）；Rust setup 独占 sidecar。capability 删除 renderer 的 `shell:allow-spawn mythpen-server`，保留 About 页需要的 `shell:allow-open`。

- [x] **Step 3: 在 spawn 前取得单实例所有权**

增加 `@tauri-apps/api` 与 desktop-only `tauri-plugin-single-instance`。single-instance 必须是 Builder 注册的第一个 plugin；第二实例 callback 只 show/unminimize/focus main window，不进入 sidecar setup、不探测 endpoint、不接触 config。

- [x] **Step 4: 保留 child event stream 并发布内存 session**

不得丢弃 `CommandEvent` receiver。Rust 生成 nonce，用 `CommandChild.write()` 发送唯一 bootstrap frame，并持续处理 stdout/stderr/terminated；只有 authenticated ready frame 能填充 session。`get_sidecar_session` 供 ServerStatusGate 轮询。

`backendRuntime.ts` 是 renderer 本地 transport 的唯一入口，统一提供 JSON、SSE 与 blob fetch；`api.ts` 的普通请求和三条 SSE、`projectExport.ts`、ServerStatusGate、BottomStatusbar 以及 SettingsDrawer 的本地 AI 请求全部改用它。GitHub release 查询仍是明确的外部 fetch。删除静态 `API_BASE` 与固定 3001；cover 继续通过认证 blob fetch + object URL，不使用无法带 header 的 `<img src=http://...>`。

- [x] **Step 5: 实现 close-request/soft-deadline UI**

窗口 close 先 prevent close 并发送 `shutdown.request`。正常 complete/owned child terminated 后宿主退出；soft deadline 只显示 ShutdownDialog，不杀进程。用户可继续等待、在 closing 前取消并恢复窗口，或明确 emergency exit；只有最后一项可 kill owned child，且不得记录 graceful complete。

- [x] **Step 6: 运行桌面测试与提交**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
node --test --test-concurrency=1 tests/backendRuntime.test.ts tests/apiNonceTransport.test.ts tests/shutdownUiState.test.ts
pnpm typecheck
pnpm build
```

Expected: PASS。

Commit: `feat: own sidecar lifecycle in tauri`

---

### Task 10: Stage A 全量验收、编译产物 smoke 与计划状态

**Files:**

- Modify: `docs/superpowers/plans/2026-08-06-l1-durability-foundation.md`
- Modify: `docs/superpowers/plans/2026-08-10-l1-durability-stage-a-compatibility-release.md`
- Create: `docs/superpowers/plans/l1-stage-a-acceptance.md`
- Modify only if required by verified behavior: `.github/workflows/build.yml`

**Interfaces:**

- Produces 可审计 Stage A acceptance report；只有真实通过的本地验收项才能勾选
  完成，installer/tag/release 始终按独立授权状态记录，不能反向决定 Stage A
  实现是否完成。

- [x] **Step 1: 自动化全量 gate**

Run:

```powershell
pnpm test:server
pnpm test:client
pnpm test:contracts
pnpm typecheck
pnpm lint
pnpm build
node --test scripts/tests/build-sidecars.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm build:sidecar
pnpm tauri build --debug --no-bundle
git diff --check
git status --short
```

Expected: 全部 exit 0；lint 若写入格式化，必须复查 diff 后重跑相关 tests。

- [x] **Step 2: 编译 sidecar/D9/D10 smoke**

> **已完成。** 当前基线上 sidecar/debug Desktop 均已编译；
> sidecar 的可执行矩阵与五个真实 Desktop 生命周期场景均通过。Desktop harness
> 已修正 `MainWindowHandle` 误选 `-siw` 辅助窗口、`remote-debugging-port=0`
> 不监听、GUI 启动方式和 CDP helper 多输出等问题。`slow_drain_cancel` 经生产
> admission 扫描、构建门禁与协调器集成测试证明在当前产物结构上不可达，正式
> 记为 `NOT APPLICABLE / STRUCTURALLY PROVEN`。详见 `l1-stage-a-acceptance.md`。

使用 `scripts/tests/desktop-lifecycle-smoke.ps1` 在临时用户 profile/data root：

1. 启动 packaged sidecar，校验 authenticated ready/build.info=`off`、full commit、target triple；
2. 占用 3001，确认 sidecar 仍用动态端口；
3. wrong nonce、cross-instance nonce 全部拒绝；
4. 第二桌面实例只聚焦，不产生第二 child/config lease；
5. 正常退出、慢 drain→继续、慢 drain→取消、明确 emergency exit；
6. 确认只可能终止 owned child。

- [x] **Step 3: Task 8 手工现场矩阵**

> v1 forward/rollback/third state、schema too new、
> 好坏项目并存、真实 export、reserved name 和外部 writer busy 的服务端/字节
> 现场均通过；RecoveryNotice 已在同一真实 Tauri/WebView2/CDP/nonce harness
> 中通过键盘/focus、取消、错误、刷新、导出、恢复与 `aria-live` 验收。

验证 v1 可前滚、可回滚、第三态、schema too new、单坏项目+健康项目、diagnostics export、reserved name、外部 writer busy。逐项记录命令、fixture、结果和未验证项，不以截图替代字节/事件断言。

- [x] **Step 4: 更新状态但不提前宣称发布**

只有代码与自动/手工验收通过时，才把 Task 8 标为“实现与本地验收完成”；
installer/tag/release 继续单列为“未授权 / 未执行”，不再作为 Task 8 或 Stage A
完成状态的后缀。Task 6 native 性能、Stage B–D 仍保持未完成。

- [x] **Step 5: 最终提交**

> **已完成。** `slow_drain_cancel` 已正式修订为受自动扫描保护的结构性合同；
> Task 10 的实现、证据和权威账本均已收口。发布是独立且尚未授权的未来交付轨，
> 不是当前下一步，也不能因本步完成而宣称兼容版本已经发布。

Commit: `test: close the stage a slow-drain gate`
