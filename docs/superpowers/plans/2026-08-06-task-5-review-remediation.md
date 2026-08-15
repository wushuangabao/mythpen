# Task 5 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Task 5 审查发现的旧连接覆盖、ControlStore incarnation 复用、journal 非线性、受控路径不严和延迟 flush 未接管错误等问题。

**Architecture:** `ControlStore` 在稳定父目录中持久化 active-incarnation 记录，并在目录内持久化不可复用 ID；每次操作同时核验 ID 与物理目录 identity。`SqlJsAtomicStore` 把正式文件 identity/hash 作为连接基线，恢复入口无条件围栏并从正式字节重装；journal 使用单 active-publication 状态机。受控 artifact 只通过 exclusive/no-follow 创建，并拒绝 reparse 父链。

**Tech Stack:** Bun、Node.js `fs`/`node:test`、sql.js、现有 `server/platform/durability.js`。

## 实施状态（2026-08-11）

- **Task 1–8 已完成**，对应修复、聚焦回归和二次独立审查均已收口。
- 本计划不再是当前执行入口；后续 ConfigLifecycleLease、Task 8 恢复入口、
  Desktop 生命周期和 Stage A 验收以
  `2026-08-10-l1-durability-stage-a-compatibility-release.md` 为准。
- 当前完整 L1 状态见 `l1-stage-a-acceptance.md`；不得因本修复计划完成而
  推导 Task 10、Stage A、Task 8 发布或完整 L1 已完成。

## Global Constraints

- 每个修复项先写测试并观察预期 RED，再修改生产代码并观察 GREEN。
- 不提前实现 Task 6 的完整跨进程 writer coordinator；但连接已落后于正式文件时必须拒绝发布。
- 不能宽泛删除恢复 artifact；无法严格证明安全的孤儿清理留待后续。
- 最终运行 server/client/typecheck/diff-check，更新 `.superpowers/sdd/task-5-report.md`，单独提交。

---

### Task 1: Recover fence 与正式 baseline

**Files:**
- Modify: `server/tests/sqljs-atomic-store.test.js`
- Modify: `server/sqljs-atomic-store.js`

**Interfaces:**
- `store.recover()` 入口立即令所有现有连接不可用；只有正式状态和 terminal 确定、正式字节重装成功后解除围栏。
- `store.publish(connection)` 比较正式文件 `{ exists, sha256, identity }` 与连接捕获基线，不匹配时抛 `DB_CONNECTION_STALE` 并保持围栏。

- [x] 写 A/B 双 store clean-recover 及 terminal append 失败测试。
- [x] 运行 `bun test ./server/tests/sqljs-atomic-store.test.js --test-name-pattern "recover|baseline"`，确认旧实现 RED。
- [x] 增加正式 snapshot/baseline，recover 无条件重装并递增 epoch。
- [x] 重跑聚焦测试确认 GREEN。

### Task 2: 永久 ControlStore incarnation

**Files:**
- Modify: `server/tests/control-store.test.js`
- Modify: `server/tests/sqljs-atomic-store.test.js`
- Modify: `server/control-store.js`
- Modify: `server/db.js`

**Interfaces:**
- `store.incarnationId` / `store.assertCurrent()`：核验目录内 ID、稳定父 active 记录及 `{dev, ino, realpath}`。
- `store.retireAndActivate(destination, validate)`：同一 lifecycle lease 内校验、退役旧目录并激活新 ID。

- [x] 写旧 store 在同路径新目录出现后 read/append/CAS 均稳定 stale 的 RED。
- [x] 写旧 AtomicStore 不能发布进新 incarnation 的 RED。
- [x] 在 lifecycle lease 内实现创建、激活、退役和每次操作 identity 核验。
- [x] 接入显式同名创建并重跑 ControlStore/AtomicStore 聚焦测试。

### Task 3: 单 active-publication journal

**Files:**
- Modify: `server/tests/sqljs-atomic-store.test.js`
- Modify: `server/sqljs-atomic-store.js`

**Interfaces:**
- `inspectPublicationJournal(...)` 按事件顺序维护最多一个 active publication。
- 新 prepared 的 before predicate 必须与上一 terminal 的正式 predicate 连续。

- [x] 写交错 `prepared(A) → prepared(B)` 与不连续 before 的 RED。
- [x] 实现线性状态机并确认聚焦 GREEN。

### Task 4: Canonical/physical identity 与安全 artifact

**Files:**
- Modify: `server/tests/sqljs-atomic-store.test.js`
- Modify: `server/tests/project-db-existence.test.js`
- Modify: `server/sqljs-atomic-store.js`
- Modify: `server/db.js`

**Interfaces:**
- journal before/terminal after 均持久化 `{dev, ino}` identity。
- candidate/backup/rollback 通过 `O_EXCL | O_NOFOLLOW`（平台支持时）创建，使用前拒绝 symlink/reparse 父链。
- canonical path 比较在 Windows 忽略大小写；`projectConnections` 使用 canonical physical key。

- [x] 写 identity、Windows 大小写、reparse/exclusive 和 canonical cache RED。
- [x] 实现 path/snapshot/artifact helpers 和 schema 核验。
- [x] 重跑相关聚焦测试确认 GREEN。

### Task 5: Scheduled flush fail-closed

**Files:**
- Modify: `server/tests/storage-reconfiguration.test.js`
- Modify: `server/db.js`
- Modify: `server/sqljs-atomic-store.js`

**Interfaces:**
- wrapper 捕获第一次 flush failure，保留 dirty，并通过 `_failure` 暴露；后续同步边界稳定抛同一错误。
- `store.fence()` 使连接进入恢复围栏。

- [x] 写 scheduled `TARGET_LOCKED` 和 stale-timer RED。
- [x] 在 `_flushSync`/timer callback 捕获并持久化失败状态。
- [x] 重跑 storage/db 聚焦测试确认 GREEN。

### Task 6: Verifier cleanup 与覆盖完整性

**Files:**
- Modify: `server/tests/sqljs-atomic-store.test.js`
- Modify: `server/sqljs-atomic-store.js`

- [x] 写验证主错误与 close/free 双失败 RED。
- [x] 保留 `CANDIDATE_VERIFICATION_FAILED` 主身份，把 cleanup 作为 secondary。
- [x] 补全部项目表重开哨兵与逻辑 FK 负例并确认 GREEN。
- [x] 报告中将严格孤儿 artifact 清理标记 deferred，禁止宽泛删除。

### Task 7: Gates、报告与提交

**Files:**
- Modify: `.superpowers/sdd/task-5-report.md`（Git ignore 下的交接报告）

- [x] 运行 `pnpm test:server`。
- [x] 运行 `pnpm test:client`。
- [x] 运行 `pnpm typecheck`。
- [x] 运行 `git diff --check` 与 `git diff --cached --check`。
- [x] 自审逐条对应 C1/C2/I1-I4/Minor 并更新报告；提交消息定为 `fix: harden atomic sql.js recovery`。

### Task 8: 二次审查阻断修复

**Files:**
- Modify: `server/tests/control-store.test.js`
- Modify: `server/control-store.js`

- [x] 用 junction/真实路径双入口复现 lifecycle lease key 可被物理别名绕过的 RED。
- [x] 将 lifecycle identity、lease 和 active record 收敛到最深存在祖先的物理 canonical 路径，并确认别名共用同一 lease。
- [x] 注入 replacement incarnation 已落盘但 active-record 写入 EIO 的 RED。
- [x] 仅凭“当前目录为纯净新 incarnation + 受控 retired-UUID 目录 dev/ino 与旧 active 相同 + 旧 incarnation ID 精确匹配”续完激活，其他替换继续 fail-closed。
- [x] 注入 incarnation final 部分写后 EIO 的 RED，改为排他 temp + fsync + hard-link no-clobber 发布 + 目录 fsync。
- [x] 补非受控 move RED；任何 active mismatch（包括刚创建的目录）都必须满足严格 retired 证据，否则保持 `CONTROL_STORE_STALE` 且不改 active record。
- [x] 补 incarnation temp 在 link 前/后 crash 的 RED；只清理精确命名且为普通文件的 incarnation temp，未知项和 symlink/目录继续 fail-closed。
- [x] 重跑二审定向 6/6、ControlStore/AtomicStore 67/67，并由独立 reviewer 重跑二审 6/6 与定向 Bun 探针。
