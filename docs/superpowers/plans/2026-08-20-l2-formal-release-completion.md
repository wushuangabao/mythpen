# L2 Formal Release Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在已提交的显式 files Beta 基础上，补齐 L2 correctness 产品接线、宿主恢复能力与本地验收源码；在增量性能门禁未闭合时保持 SQLite 默认并只声明 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`。

**Architecture:** 本计划不重写 `2026-08-17-l2-file-authority.md` 的协议，而是恢复其被 Beta checkpoint 后移的执行链。依赖顺序固定为 projection-only orphan resolution → retirement/data-root policy → brokered product routing/recovery → host/UI → correctness matrices → performance/capability source；每一层只消费前一层的 module-authentic authority，不接受 caller-built path、row、intent、epoch 或 evidence。

**Tech Stack:** Bun 1.3.14、Node.js 24、Express/CommonJS、React 19/TypeScript、Tauri 2/Rust、sql.js + bun:sqlite native adapter、Node/Bun test runner、Biome。

## Global Constraints

- `docs/superpowers/plans/2026-08-17-l2-file-authority.md` v2.12 和 `docs/superpowers/specs/2026-08-15-l2-file-authority-spec.md` 是行为真值；本计划只编排后移任务。
- `Task 10P` 固定 omitted：ordinary-dirty 始终 FULL，不创建或接线 `incremental-refresh.js`、`selfEventProof` 或 `incrementalRefresh` port。
- 在 `<120 ms` 文件侧增量门禁没有真实证据前，普通创建默认值保持 `sqlite`，files 只保留显式入口。
- 任何未运行的 production candidate、Windows VM、compiled E2E、benchmark 或 desktop smoke 只能记为 `NOT_RUN`/`DEFERRED`。
- 所有新行为先写失败测试，确认 RED 原因正确，再实现 GREEN；每个任务经独立 spec/code review 后单独本地提交，不推送。
- 所有受控文件路径只由 server/host 根据 project UID、resource UID 和 canonical root 解析；API、CLI、renderer 不传绝对路径或 member path。
- `EXTERNAL_DRAFT_CONFLICT` 与 `RECOVERY_REQUIRED` 必须保留本地草稿、阻止自动重试；显式 flush 必须 reject，不能报告 durable success。
- 全量 TypeScript 使用 `pnpm tsc --project tsconfig.app.json --noEmit`；Biome 验证使用只读 `biome check`，不得把 `pnpm lint` 当只读命令。

---

### Task 1: Projection-only orphan resolution（原 Task 10A2）

**Files:**
- Create: `server/manuscript/orphan-resolution-service.js`
- Create: `server/tests/manuscript-orphan-resolution.test.js`
- Modify: `server/manuscript/ignored-ledger.js`
- Modify: `server/manuscript/store.js`
- Modify: `server/manuscript/projection-store.js`
- Modify: `server/manuscript/l2-service.js`
- Modify: `server/tests/manuscript-ignored-ledger.test.js`
- Modify: `server/tests/manuscript-store.test.js`
- Modify: `server/tests/manuscript-projection-store.test.js`
- Modify: `server/tests/manuscript-service-l2.test.js`

**Interfaces:**
- Consumes: Task 10A1 branded ignored-ledger baseline、Task 12 real schema-12 projection adapter、同一 writer turn 的 original projection context。
- Produces:

```js
class OrphanResolutionService {
  snapshotRequest(request) {}
  preflightResolution(action, request, baselineContext) {}
  publishResolution(preparedResolution, projectionContext) {}
}

function canonicalSchema12ReuseIdentityPlan(currentProjection) {}
```

- [ ] **Step 1: 写 RED focused tests**

  覆盖 exact `{kind:'chapter'|'volume', uid}` freeze/zero-I/O、single full scan、`new_active|reactivate|revoke`、active no-op、第二 unknown/错 UID/clone/stale/foreign authority 零 publish、revoke 后 ordinary FULL 再次阻断，以及 reuse plan 拒绝 schema11/漏 tombstone/inexact rows。

```js
const request = service.snapshotRequest({ kind: 'chapter', uid: CHAPTER_UID })
assert.ok(Object.isFrozen(request))
assert.equal(io.calls, 0)
await assert.rejects(
  service.preflightResolution('ignore_in_place', request, { ...baseline }),
  /original branded baseline/i,
)
assert.equal(adapter.publishCalls, 0)
```

- [ ] **Step 2: 运行 RED**

```powershell
bun test server/tests/manuscript-orphan-resolution.test.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-service-l2.test.js
```

  预期：因 `orphan-resolution-service.js` 和 reuse-plan producer 缺失失败；不得通过放宽现有 authority validator 让 RED 假绿。

- [ ] **Step 3: 实现最小 production authority**

  `snapshotRequest()` 仅验证 own data 并递归冻结；`preflightResolution()` 以 target pending overlay 对同一 tree 做唯一一次完整扫描并铸 module-private prepared authority；`publishResolution()` 只消费该原 authority和真实 projection adapter context。受控文件保持逐字节不变，不创建 FilePublicationJournal，不暴露 API。

- [ ] **Step 4: 运行 GREEN 与静态检查**

```powershell
bun test server/tests/manuscript-orphan-resolution.test.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-service-l2.test.js
git diff --check
```

- [ ] **Step 5: 独立 review 后提交**

```powershell
git add server/manuscript/orphan-resolution-service.js server/manuscript/ignored-ledger.js server/manuscript/store.js server/manuscript/projection-store.js server/manuscript/l2-service.js server/tests/manuscript-orphan-resolution.test.js server/tests/manuscript-ignored-ledger.test.js server/tests/manuscript-store.test.js server/tests/manuscript-projection-store.test.js server/tests/manuscript-service-l2.test.js
git commit -m "feat(l2): resolve orphan projections safely"
```

---

### Task 2: Retirement lifecycle 与 data-root guard（原 Task 14）

**Files:**
- Create: `server/manuscript/retirement-service.js`
- Create: `server/manuscript/data-root-guard.js`
- Create: `server/tests/manuscript-retirement.test.js`
- Create: `server/tests/manuscript-data-root-guard.test.js`
- Modify: `server/manuscript/session-controller.js`

**Interfaces:**
- Consumes: lifecycle lease/session admission、route-store CAS、production roots、ProjectCreationJournal enumeration。
- Produces:

```js
const epoch = controller.beginRetiring(projectSelector)
await controller.drain(epoch)
controller.resumeAfterRetirementFailure(epoch, currentIdentity)

class RetirementService {
  retire(request) {}
  reactivate(request) {}
}

function assertNativeDataRootChangeAllowed(snapshot) {}
function inspectCloudOrReparseRoot(candidateRoot) {}
```

- [ ] **Step 1: 写 RED**：确定性交错覆盖 admission 后/registry 前、writer 前、跨进程 shared 导致 `PROJECT_WRITE_BUSY`、同 epoch 恢复、`retired→files` 重激活不复用旧 clean/feed；data-root 覆盖 files/migrating/retired/nonterminal creation journal 和 OneDrive/iCloud/reparse 在 mkdir/copy 前拒绝。
- [ ] **Step 2: 运行 RED**：

```powershell
bun test --timeout 60000 server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js server/tests/manuscript-session-controller.test.js
```

- [ ] **Step 3: 实现状态机**：registry/config 内只切 retiring 并铸 opaque epoch；释放所有 lease 后 drain；重取 lease、重验 identity/generation 后执行 writer/feed/session/shared/exclusive/route CAS；data-root guard 只返回 policy result，不修改产品入口。
- [ ] **Step 4: GREEN、review、提交**：

```powershell
bun test --timeout 60000 server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js server/tests/manuscript-session-controller.test.js
git diff --check
git add server/manuscript/retirement-service.js server/manuscript/data-root-guard.js server/manuscript/session-controller.js server/tests/manuscript-retirement.test.js server/tests/manuscript-data-root-guard.test.js server/tests/manuscript-session-controller.test.js
git commit -m "feat(l2): retire file projects safely"
```

---

### Task 3: Brokered product gates 与 readable composition（原 Task 14B core）

**Files:**
- Create: `server/tests/manuscript-product-routing.test.js`
- Modify: `server/manuscript-service.js`
- Modify: `server/manuscript/product-gates.js`
- Modify: `server/manuscript/freshness.js`
- Modify: `server/manuscript/l2-service.js`
- Modify: `server/manuscript/production-runtime.js`
- Modify: `server/manuscript/uid-reservation-sources.js`
- Modify: `server/db.js`

**Interfaces:**
- Consumes: Task 1 orphan service、Task 2 retirement policy、Task 9D session/writer/freshness、Task 11A DraftConflictJournal。
- Produces stable original broker authority：

```js
const productWriteIntents = {
  bindL2Command(command) {},
  bindOrphanAction(action, request) {},
  authority() {},
  execute(intent, turnContext) {},
}

await ensureProjectionCurrentForWrite(admission, writerTurn, Object.freeze({
  logicalRequestId,
  writeIntent,
}))
```

- [ ] **Step 1: 写 RED**：`product-gates` request 必须是 exact 三键；plain/clone/foreign/swap intent 在 admission/scan/journal 前失败；ordinary dirty 必须 FULL；orphan resolution 只能 capture baseline→policy→single scan→projection，不能 ordinary FULL；production boundary cap swap 在枚举前失败。
- [ ] **Step 2: 运行 RED**：

```powershell
bun test --timeout 120000 server/tests/manuscript-product-routing.test.js server/tests/manuscript-freshness.test.js server/tests/manuscript-product-gates.test.js server/tests/manuscript-runtime.test.js
```

- [ ] **Step 3: 实现私有 broker 和唯一 composition root**：WeakMap 只记录 original downstream intent/snapshot；authority 只 assert/describe；gate/freshness 复验同一 intent；schema12 只在 activated migration/creation proof + route + v2 inspector 全匹配时接纳。
- [ ] **Step 4: GREEN、review、提交**：运行 Step 2、`git diff --check`，精确暂存上述文件后提交 `feat(l2): broker product authority gates`。

---

### Task 4: 将 REST、tools、AI、revision、export、stats、recent 与 CLI 收口到 L2（原 Task 14B entrypoints）

**Files:**
- Modify: `server/routes/api.js`
- Modify: `server/tools.js`
- Modify: `server/project-export.js`
- Modify: `server/index.js`
- Modify: `server/cli.js`
- Modify: `server/ai-continue-save.js`
- Modify: `server/chapter-revisions.js`
- Modify: `server/prompts/context.js`
- Modify: `server/recent-projects.js`
- Modify: `server/storage-migration.js`
- Modify: `server/manuscript-sql-guard.js`
- Modify: `scripts/manuscript-write-scan.mjs`
- Modify: `scripts/tests/manuscript-write-scan.test.mjs`
- Modify: `src/lib/api.ts`
- Modify: existing owner tests listed in the normative Task 14B plan section。

**Interfaces:**
- Reads: admitted readable wrapper + `ActiveManuscriptProjection` only。
- Writes: session admission → writer → freshness → original broker intent → domain service only。
- `ChapterRevision.status` becomes `pending | accepted | rejected | superseded | stale`; `stale` is historical and cannot be accepted/rejected。

- [ ] **Step 1: 扩展静态扫描 RED**：对 files route 中 project DB 文章真值直写、章节/卷 DELETE、`MAX(num)`、`expected_resolve_chapter`、caller controlled path、tombstone/old-generation read 逐类使用最小 fixture 并要求 fail。
- [ ] **Step 2: 写路由 RED**：正文/标题/大纲/状态/摘要/五叙事字段、卷 CRUD/move/reorder/delete、AI tools/continue、revision、export/stats/recent/CLI 全部断言 files 不调用旧 SQL owner；sqlite 保持旧路径。
- [ ] **Step 3: 分 owner 迁移入口**：先 routes/tools/revisions，再 AI/context，再 export/stats/recent/CLI/data-root；每个 owner 只删除该 owner 的扫描债务，不加路径或整文件 allowlist。
- [ ] **Step 4: 运行 owner suites**：

```powershell
bun test --timeout 120000 server/tests/manuscript-product-routing.test.js server/tests/chapter-update-api.test.js server/tests/chapter-tools-identity.test.js server/tests/project-export.test.js server/tests/project-delete-api.test.js server/tests/storage-migration.test.js server/tests/cli.test.js server/tests/recent-projects.test.js
node --test scripts/tests/manuscript-write-scan.test.mjs
```

- [ ] **Step 5: typecheck/review/提交**：

```powershell
pnpm tsc --project tsconfig.app.json --noEmit
git diff --check
git commit -m "refactor(l2): route manuscript products through authority"
```

---

### Task 5: Draft conflict recovery 与 host-only migration admission（原 Task 14B recovery）

**Files:**
- Create: `server/manuscript/draft-conflict-service.js`
- Create: `server/tests/draft-conflict-service.test.js`
- Create: `server/tests/manuscript-recovery-api.test.js`
- Create: `src/lib/manuscriptMigrationAdmission.ts`
- Create: `tests/manuscriptMigrationAdmission.test.ts`
- Modify: `server/routes/api.js`
- Modify: `src/lib/api.ts`

**Interfaces:**

```ts
beginMigrationAfterHostPreflight(
  snapshot: FrozenHostDirtySnapshot,
  request: FrozenMigrationRequest,
): Promise<MigrationResult>
```

```js
class DraftConflictService {
  listConflicts(context) {}
  createBackup(intent, context) {}
  acceptExternal(intent, context) {}
  applySavedDraft(intent, context) {}
}
```

- [ ] **Step 1: RED**：snapshot/window set 变化、未响应窗口、未解决 dirty、queue 未 cancelled+drained 时 migration API call=0 且 journal/route/DB/ControlStore/paths bytes 不变；conflict epoch stale、backup 非 durable、plain intent、child publication failure 均零错误完成态。
- [ ] **Step 2: 实现**：host seam 只消费同一不可变 snapshot；DraftConflictService 组合 opaque journal intent、Task 12 projection CAS、Task 6 parent=`draft_conflict` child，只有 `backup_durable` 可展示 backup。
- [ ] **Step 3: GREEN、typecheck、review、提交**：

```powershell
bun test --timeout 120000 server/tests/draft-conflict-service.test.js server/tests/manuscript-recovery-api.test.js
node --test --test-concurrency=1 tests/manuscriptMigrationAdmission.test.ts
pnpm tsc --project tsconfig.app.json --noEmit
git diff --check
git commit -m "feat(l2): recover conflicts through durable authority"
```

---

### Task 6: 多窗口 coordinator、恢复/孤儿/退役 UI 与诊断状态（原 Task 15 renderer）

**Files:**
- Create: `src/lib/manuscriptWindowCoordinator.ts`
- Create: `src/lib/manuscriptRecoveryState.ts`
- Create: `src/components/DraftConflictDialog.tsx`
- Create: `src/components/OrphanResourceDialog.tsx`
- Create: `src/components/RetiredProjectsDialog.tsx`
- Create: `src/components/ManuscriptDiagnosticsDialog.tsx`
- Modify: `src/components/EditorContent.tsx`
- Modify: `src/pages/ProjectList.tsx`
- Modify: `src/lib/api.ts`
- Create: `tests/manuscriptWindowCoordinator.test.ts`
- Create: `tests/manuscriptRecoveryState.test.ts`

**Interfaces:**
- `freezeAllWindows(projectInstanceId)` 返回 exact window set、每个 dirty resource 的 `persisted|explicitly_resolved` 与 queue `cancelled_and_drained` proof。
- Recovery dialog 只调用 Task 5 API；orphan/retirement dialog 只调用 Tasks 1–2 product endpoints；diagnostic payload 不含正文或绝对用户路径。

- [ ] **Step 1: 写 RED imports/tests**：跨窗口 late write、window timeout、sidecar/structure/volume/unloaded dirty、stale conflict epoch、80% capacity warning、feed degraded、refresh cancel。
- [ ] **Step 2: 实现 coordinator/store/components**：任何窗口未响应或 snapshot 漂移都 fail-closed；只读保护码在明确 resolution 后才解除。
- [ ] **Step 3: 聚焦 tests + typecheck + review + commit**：

```powershell
node --test --test-concurrency=1 tests/manuscriptWindowCoordinator.test.ts tests/manuscriptRecoveryState.test.ts tests/dirtyResourceRegistry.test.ts tests/manuscriptMigrationAdmission.test.ts
pnpm tsc --project tsconfig.app.json --noEmit
git diff --check
git commit -m "feat(l2): coordinate manuscript recovery UI"
```

---

### Task 7: 安全 open/reveal 宿主命令与 desktop smokes（原 Task 15 host）

**Files:**
- Create: `src-tauri/src/manuscript_files.rs`
- Modify: `src-tauri/src/lib.rs`
- Create: `src-tauri/tests/manuscript_files_integration.rs`
- Create: `scripts/tests/desktop-manuscript-files-smoke.ps1`
- Create: `scripts/tests/desktop-manuscript-migration-preflight-smoke.ps1`

**Interfaces:**
- Renderer 只发送 project UID、instance UID、resource kind/UID；Rust 从 authenticated sidecar session 和 canonical root 重新解析并复核路径。
- open/reveal 拒绝 sqlite/migrating/retired、reparse、root escape、UID/path mismatch、stale instance 和 unauthenticated session。

- [ ] **Step 1: Rust RED integration tests**：合法 files resource、root escape、symlink/reparse、stale instance、route mismatch、missing resource。
- [ ] **Step 2: 实现 resolver + IPC**：不接受 renderer absolute path，不跟随重解析点，不用 shell 拼接命令。
- [ ] **Step 3: 编译与 smoke**：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml manuscript_files
pnpm tauri build --debug
powershell -NoProfile -File scripts/tests/desktop-manuscript-files-smoke.ps1
powershell -NoProfile -File scripts/tests/desktop-manuscript-migration-preflight-smoke.ps1
```

- [ ] **Step 4: review、提交**：`git diff --check` 后提交 `feat(l2): expose safe manuscript file host commands`。

---

### Task 8: 冻结本地 correctness/two-process/capacity/performance harness（原 Task 16）

**Files:**
- Create: `server/tests/l2-correctness-matrix.test.js`
- Create: `server/tests/l2-two-process-matrix.test.js`
- Create: `server/tests/l2-capacity-boundary.test.js`
- Create: `server/tests/l2-performance-benchmark.test.js`
- Create: `server/tests/fixtures/create-l2-benchmark-project.js`

**Interfaces:**
- Fixture 以 deterministic seed 生成 3,000 章/30–40 MiB 与 10,000 章/1 GiB 两个不可缩小 manifest，并输出 file count、bytes、SHA-256 tree digest。
- Matrix result 固定 case ID、pass/fail、duration、source commit、target triple；本地 source run 不发布 production evidence。

- [ ] **Step 1: 写 source-contract RED**：缺 case、重复 case、缩小 fixture、非 canonical manifest、外部结果路径覆盖均失败。
- [ ] **Step 2: 实现四个 harness 与 fixture**：correctness join Tasks 2–15；two-process 覆盖 writer/refresh/session/retire；capacity 证明超限前短路且现场不变；performance 只测 full-only 并将 incremental 标为 NOT_RUN。
- [ ] **Step 3: 运行本地 join**：

```powershell
bun test --timeout 600000 server/tests/l2-correctness-matrix.test.js server/tests/l2-two-process-matrix.test.js server/tests/l2-capacity-boundary.test.js server/tests/l2-performance-benchmark.test.js
git diff --check
```

- [ ] **Step 4: review、提交**：提交 `test(l2): freeze local correctness acceptance`。

---

### Task 9: 本机 performance preflight 与状态决定（原 Task 17A）

**Files:**
- Create: `docs/superpowers/plans/l2-performance-preflight.md`

- [ ] **Step 1: 编译 source-bound sidecar**：`pnpm build:sidecar`，记录 source commit、triple、CPU、磁盘、冷/热缓存、安全软件状态。
- [ ] **Step 2: 运行 Task 8 benchmark**：`bun test --timeout 600000 server/tests/l2-performance-benchmark.test.js`，记录全部样本、nearest-rank p50/p95/max。
- [ ] **Step 3: 写状态**：列表/侧栏 `<150 ms`、autosave `<300 ms`；incremental 固定 `NOT_RUN`，因此最高只能写 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，保持 SQLite default。
- [ ] **Step 4: review、提交**：只提交 preflight 文档，commit `docs(l2): record performance preflight`。

---

### Task 10: Final acceptance source 与 capability build-info（原 Task 17B source checkpoint）

**Files:**
- Create: `server/tests/native-durability-benchmark.test.js`
- Create: `scripts/tests/l2-production-e2e.test.mjs`
- Modify: `scripts/tests/l1-production-e2e.test.mjs`
- Modify: `server/build-info.js`
- Modify: `server/sidecar-control.js`
- Modify: `server/tests/sidecar-control.test.js`
- Modify: `scripts/build-sidecars.mjs`
- Modify: `scripts/tests/build-sidecars.test.mjs`
- Modify: `src-tauri/src/sidecar_protocol.rs`
- Modify: `src/lib/backendRuntime.ts`
- Modify: `tests/backendRuntime.test.ts`
- Modify: `tests/apiNonceTransport.test.ts`

**Interfaces:**

```js
Object.freeze({
  nativeActivationMode,
  sourceCommit,
  targetTriple,
  manuscriptLifecycleLease: boolean,
  manuscriptChangeNotification: boolean,
})
```

- [ ] **Step 1: source-contract RED**：required case IDs、create-new result path、source/triple/hash binding、缺/额外 capability key、ready/build.info mismatch、off/source fallback 误报 true 全部 fail。
- [ ] **Step 2: 端到端增加两个 boolean**：compile defines→server ready/build.info→Rust exact parser/session→renderer validator；source/off fallback 固定 false，只有 production compile arguments 固定 true。
- [ ] **Step 3: 保持 default route**：因为 Task 9 的 incremental 为 NOT_RUN，本任务不改 `projectCreationStorage.ts`、不创建 default files route commit。
- [ ] **Step 4: focused + Rust + typecheck/build**：

```powershell
bun test --test-name-pattern "production acceptance harness source contract" server/tests/native-durability-benchmark.test.js
node --test --test-name-pattern "production acceptance harness source contract" scripts/tests/l1-production-e2e.test.mjs scripts/tests/l2-production-e2e.test.mjs
bun test server/tests/sidecar-control.test.js
node --test scripts/tests/build-sidecars.test.mjs tests/backendRuntime.test.ts tests/apiNonceTransport.test.ts
cargo test --manifest-path src-tauri/Cargo.toml sidecar_protocol
pnpm tsc --project tsconfig.app.json --noEmit
pnpm tauri build --debug
```

- [ ] **Step 5: review、提交**：提交 `feat(l2): publish final capability source`。

---

### Task 11: Final external evidence（不可由源码测试替代）

**Files after successful artifact validation only:**
- Modify: `docs/superpowers/plans/l2-production-candidate-acceptance.md`
- Create/Modify: `docs/superpowers/plans/l2-performance-evidence.md`
- Modify: `docs/superpowers/specs/2026-08-15-l2-file-authority-spec.md`

- [ ] **Step 1: 冻结 clean source SHA**，确认没有任何生产源码、test harness 或 build script 未提交改动。
- [ ] **Step 2: 在最终 SHA 运行 Windows VM L1 13/19、L2 correctness/two-process/capacity matrices、compiled L1/L2 E2E、native/L2 benchmark、fresh debug desktop lifecycle/files/migration smokes。**
- [ ] **Step 3: 独立 reviewer 核对 raw log、exit code、case count、source/triple、candidate/manifest/result SHA-256。**
- [ ] **Step 4: 只在证据真实存在时更新文档**；本计划预期状态为 `CORRECTNESS_COMPLETE / PERFORMANCE_DEFERRED`，不得写 `DEFAULT_READY`。
- [ ] **Step 5: 提交证据文档**：`docs(l2): record correctness-complete artifact evidence`；不推送。

## Self-Review

- Spec coverage：Tasks 10A2、14、14B、15、16、17A、17B 均有对应任务；Task 10P 按已裁决 omitted，未误列为实现项。
- Placeholder scan：所有 production/test 路径均精确列出；没有 TODO/TBD、平行 owner 或可由实现者随意命名的模块。
- Type consistency：orphan request、retirement epoch、product write intent、host dirty snapshot、build-info booleans 均由单一 owner 产生并由后续层消费；没有把 plain caller data 升格为 authority。
- Evidence boundary：Tasks 1–10 只产生源码、本地测试和本机 preflight；只有 Task 11 能更新最终 evidence，并明确不能宣称 `DEFAULT_READY`。
