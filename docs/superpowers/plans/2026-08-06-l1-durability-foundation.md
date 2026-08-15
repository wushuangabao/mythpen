# L1 耐久性地基实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让项目数据库的每一次落盘都是可证明的原子发布，让并发写入由 OS 强制串行，并把所有正文写入收口到单一服务，使崩溃或掉电后数据库始终是完整的 before 或 after 之一。

**范围依据：** `docs/superpowers/specs/2026-08-06-manuscript-durability-and-versioning-v1-scope.md` 第 4 节（L1）。不引入文件权威层、Git 或 AI 侧耐久化。

**架构：** 平台原语收敛到 `server/platform/durability.js`（Windows 走 `bun:ffi` → kernel32，POSIX 走 `flock` + 目录 fd）。其上是 `ControlStore`（只追加事件日志）与 `SqlJsAtomicStore`（候选库发布 + connection epoch），再上是 `ProjectWriteCoordinator`（跨进程 lease + 进程内 FIFO）。`ManuscriptService` 是唯一允许写 `chapters.content` 的出口。故障注入框架贯穿全部层次。

**技术栈：** Bun 1.3.14（开发/测试/生产统一）、sql.js 1.13、Express 5、`node:test`（由 `bun test` 执行）、Biome。

## 实施状态（2026-08-12）

- **Task 1–5：已完成**，并通过逐任务独立审查。
- **Task 6：正确性基础已完成，性能验收延期且未通过。** 2026-08-11 以统一的 3,000 章、2+20/nearest-rank 方法重跑后，full publish p95=1122.41 ms、端到端保存 p95=1664.70 ms，仍超过 500/300 ms 原始阈值。Stage B Task 1–7 correctness 已完成：schema 11 direct fixture、NativeProjectStore transaction/recovery、bounded ControlStore checkpoint、native checkpoint integration/high-water scheduling 与 shutdown 门禁均已通过独立审查；production wiring 仍保持 off。
- **Task 7：已完成**，正文写入已收口到 `ManuscriptService`，最终独立审查通过。
- **Task 8：实现与本地验收已完成；对外发布未授权。** Stage A 服务端现场矩阵、五个真实 Desktop 生命周期场景及同一 Tauri/WebView2/CDP/nonce 通道上的 RecoveryNotice E2E 已通过；slow-drain 合同已用生产调用链、自动扫描门禁与协调器测试正式闭环。installer、tag、release 不属于当前执行范围，也不是继续完整 L1 实现的前置。
- **Stage A：Task 1–10 本地验收已完成。** 当前权威验收账本见 `l1-stage-a-acceptance.md`。
- **Stage B correctness：已完成。** Task 7 实现提交为 `bef7445`；权威证据见 `l1-stage-b-acceptance.md`。internal diagnostics 保持 `DEFERRED`，native benchmark 保持 `NOT_RUN`，形式 binary-token 门禁与性能阈值尚未通过。
- **整体状态：部分完成。** 不得宣称完整 L1 已完成或已发布。

## 当前卡点与执行顺序

当前没有已知的 Stage A 正确性或本地验收阻断。完整 L1 的当前未完成项是：

1. **原生项目存储与性能缺口：** Stage B Task 1–7 correctness 已完成，但当前
   sql.js 全库发布仍未达到性能阈值；internal diagnostics、native benchmark、Stage C
   activation/旧版本 DML 负控及 Stage D production candidate 尚未实施。
2. **平台证据缺口：** POSIX missing-formal verified install、Linux/macOS capability
   与最终 production 候选的跨平台矩阵尚未完成。

当前实现顺序固定为：Stage C fixture activation/旧版本 DML 负控 → 形式构建门禁、性能和
跨平台矩阵重跑 → Stage D production candidate。
Stage B 的当前权威执行计划是
`2026-08-11-l1-durability-stage-b-native-project-store.md`。
当前 Stage B Task 1–7 correctness 已完成并通过独立复审；Task 7 总审为 APPROVE，
Critical 0、可复现数据损坏风险 0。production factory 仍保持禁用，完整 L1 仍受 Stage C/D、
性能、形式 sidecar token 门禁与平台证据阻塞。Task 7 internal diagnostics 与 benchmark
按收敛决定分别保持 `DEFERRED` / `NOT_RUN`，不得折算为通过。
installer、tag、release 是独立交付轨，只有完整 L1 候选达到发布状态并再次获得
用户明确授权后才执行；不得把发布当作进入 Stage B/C 的前置。不得为了提前勾选
而放宽 fixture、阈值、nonce/owned-child 边界或引入 production runtime 测试旁路。

## 全局约束

- **不得降低现有数据安全性。** 任何一步的中间态都必须保证：正式数据库要么是改造前的行为，要么是新协议的完整行为，不能出现"新代码写一半、旧代码兜不住"的窗口。
- **每个任务结束时全套测试必须通过**（`bun test ./server/tests/` 与 `pnpm test:client`），不接受"后面任务再修"。
- **原始 Task 1–8 不改变业务行为、REST 契约或生产数据库 schema。** Stage B
  只在隔离 direct fixture 中安装设计已冻结的 schema 11 耐久元数据与降级写屏障；
  在 Stage C activation 完成前，生产 `db.js` 仍保持 schema 10，用户项目不迁移。
- **平台能力缺失时明确拒绝启动**，不静默降级为旧的不安全写入。
- 保留用户自有的未跟踪 skill 目录，不提交 `logs/`、`.probe-tmp/` 之类的临时产物。

## 已验证的事实（实施时可直接依赖）

在 Windows 10 + Node 24.11.1 + Bun 1.3.14 上实测：

- `fs.constants.O_EXLOCK` 在两个运行时下均未定义，同一文件可重复打开，**标准 `fs` 无法提供互斥**。
- `fs.fsyncSync` 作用于目录句柄返回 `EPERM`（两个运行时一致）。
- `CreateFileW(path, GENERIC_READ|GENERIC_WRITE, share=0, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL)` 提供 OS 强制独占；竞争者得到 `GetLastError() == 32`（`ERROR_SHARING_VIOLATION`）。
- `CreateFileW(dir, GENERIC_WRITE, share, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS)` + `FlushFileBuffers` 在 NTFS 上成功；**必须是 `GENERIC_WRITE`**，`GENERIC_READ` 或零访问权限都返回 `ERROR_ACCESS_DENIED (5)`。
- `bun:ffi` 在 `bun build --compile` 产出的单文件 exe 中正常工作（运行时 `LoadLibrary` 系统 DLL，非嵌入 `.node`）。
- `rename` 覆盖**正被其他句柄打开**的目标文件在两个运行时下均返回 `EPERM`（libuv 未设置 `FILE_SHARE_DELETE`）。
- `bun test` 能执行现有 `node:test` 文件；单文件全绿，37 文件同进程并行时 120 通过 / 20 失败，原因是共享 `MYTHPEN_DATA_DIR` 与 `db.js` 模块级单例。
- Express 服务端在 Bun 下可正常启动，`/api/health` 返回 200。

---

### Task 1: 让存储路径可重配置，并把服务端测试与开发统一到 Bun

FFI 只存在于 Bun，所以耐久层的测试必须跑在 Bun 上，否则测的不是要发布的实现。当前阻碍是 `server/db.js:13` 在模块加载时就固化了 `STORAGE_PATHS`，`node --test` 靠每文件独立进程绕过了这个问题，同进程的 `bun test` 绕不过。

**Files:**
- Modify: `server/db.js:13-21,986-1013`
- Modify: `server/ai-adapter.js:14`
- Create: `server/tests/helpers/isolated-data-dir.js`
- Create: `server/tests/storage-reconfiguration.test.js`
- Modify: 全部设置 `MYTHPEN_DATA_DIR` 的测试文件（约 20 个，用 `rg -l MYTHPEN_DATA_DIR server/tests` 枚举）
- Modify: `package.json:20-22,26-27`

**Interfaces:**
- `db.configureStorage(overrides?): StoragePaths` — 重新解析路径（`overrides.dataDir` 优先于 `MYTHPEN_DATA_DIR`，再退到 path store 与默认值），创建必要目录，关闭并清空 `projectConnections`，丢弃 `configDb`。返回解析后的路径。
- `db.getStoragePaths(): StoragePaths` — 未配置时惰性调用 `configureStorage()`。
- 测试助手 `withIsolatedDataDir(t): { dataDir }` — `mkdtemp` + `configureStorage` + 在 `t.after` 中关闭连接、还原路径、删除目录。

- [x] **Step 1: 写失败测试，证明同进程内可以切换数据根**

```js
// server/tests/storage-reconfiguration.test.js
const first = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-a-'));
const second = fs.mkdtempSync(path.join(os.tmpdir(), 'mythpen-storage-b-'));

db.configureStorage({ dataDir: first });
await db.initDatabase();
db.createProjectDb('alpha');
assert.equal(db.getDataDir(), first);
assert.ok(fs.existsSync(path.join(first, 'projects', 'alpha.mythpen.db')));

db.configureStorage({ dataDir: second });
await db.initDatabase();
assert.equal(db.getDataDir(), second);
// 第二个根必须完全干净，且不得复用第一个根的缓存连接
assert.equal(fs.existsSync(path.join(second, 'projects', 'alpha.mythpen.db')), false);
assert.deepEqual(db.getConfigDb().prepare('SELECT * FROM recent_projects').all(), []);
```

- [x] **Step 2: 在 Bun 下运行，观察失败**

Run: `bun test ./server/tests/storage-reconfiguration.test.js`

Expected: FAIL，`configureStorage` 不存在。

- [x] **Step 3: 把 db.js 的模块级路径改为可重配置状态**

将 `const STORAGE_PATHS = resolveStoragePaths()` 与其后的两个 `mkdirSync` 副作用（`server/db.js:13-21`）替换为惰性状态：

```js
let storagePaths = null;

function configureStorage(overrides = {}) {
  for (const [filePath, projectDb] of projectConnections) {
    try { projectDb.close(); } catch { /* 切换数据根时旧连接不可用是预期的 */ }
    projectConnections.delete(filePath);
  }
  configDb = null;
  storagePaths = resolveStoragePaths(
    overrides.dataDir ? { env: { ...process.env, MYTHPEN_DATA_DIR: overrides.dataDir } } : {},
  );
  fs.mkdirSync(storagePaths.dataDir, { recursive: true });
  fs.mkdirSync(storagePaths.projectsDir, { recursive: true });
  return storagePaths;
}

function getStoragePaths() {
  return storagePaths || configureStorage();
}
```

把文件内所有 `DB_DIR` / `CONFIG_DB` / `PROJECTS_DIR` / `EXPORT_DIR` 的读取改为 `getStoragePaths().xxx`，导出 `configureStorage` 与 `getStoragePaths`，并让 `getDataDir` / `getExportDir` 走同一入口。`server/ai-adapter.js:14` 的模块级 `resolveStoragePaths().aiRequestParametersPath` 同样改为惰性求值。

- [x] **Step 4: 抽出测试助手并迁移现有测试**

`withIsolatedDataDir` 承担现在每个测试文件里重复的 `mkdtemp` + 保存/还原 `MYTHPEN_DATA_DIR` + 清理逻辑，并额外在 `t.after` 中调用 `configureStorage()` 复位。逐个迁移设置 `MYTHPEN_DATA_DIR` 的测试文件，删除它们各自的样板。

- [x] **Step 5: 切换测试与开发运行时到 Bun**

`package.json` 中：`"test:server": "bun test ./server/tests/"`、`"dev:server": "bun --watch server/index.js"`、`"seed": "bun server/seed.js"`，`dev:all` 相应改用 `bun server/seed.js`。移除 `nodemon` 依赖。

- [x] **Step 6: 全套服务端测试在单进程内通过**

Run: `bun test ./server/tests/`

Expected: 140 pass / 0 fail（当前基线是 120/20）。任何剩余失败都必须定位到具体的共享状态并修掉，不允许用 `--concurrency 1` 之类的开关掩盖。

---

### Task 2: 平台耐久性原语模块

**Files:**
- Create: `server/platform/durability.js`
- Create: `server/platform/durability-win32.js`
- Create: `server/platform/durability-posix.js`
- Create: `server/tests/durability-primitives.test.js`
- Create: `server/tests/fixtures/lease-holder.js`

**Interfaces:**
- `detectCapabilities(): { backend, exclusiveLease, directoryFsync, atomicReplace }`
- `acquireExclusiveLease(lockPath): Lease` — 成功返回持有句柄的 `{ release(), isHeld() }`；被占用时抛 `LeaseBusyError`。
- `fsyncFile(filePath)` / `fsyncDirectory(dirPath)`
- `atomicReplace(tempPath, targetPath, { attempts = 5, backoffMs = 20 })` — 目标被第三方句柄占用时重试，耗尽后抛 `TargetLockedError`。
- 全部错误带稳定 `code`：`LEASE_BUSY`、`LEASE_LOST`、`TARGET_LOCKED`、`DURABILITY_UNSUPPORTED`。

- [x] **Step 1: 写失败测试，覆盖四类能力**

```js
// 同进程互斥
const held = acquireExclusiveLease(lockPath);
assert.throws(() => acquireExclusiveLease(lockPath), { code: 'LEASE_BUSY' });
held.release();
acquireExclusiveLease(lockPath).release(); // 释放后可再获取

// 跨进程互斥 + 进程死亡自动释放
const child = spawn('bun', ['server/tests/fixtures/lease-holder.js', lockPath]);
await waitForLine(child, 'acquired');
assert.throws(() => acquireExclusiveLease(lockPath), { code: 'LEASE_BUSY' });
child.kill('SIGKILL');
await waitForExit(child);
acquireExclusiveLease(lockPath).release(); // OS 已回收句柄

// 目录持久化
fsyncDirectory(dir); // 不抛错

// 被占用的替换目标
const reader = fs.openSync(target, 'r');
assert.throws(() => atomicReplace(candidate, target, { attempts: 2 }), { code: 'TARGET_LOCKED' });
fs.closeSync(reader);
atomicReplace(candidate, target); // 句柄释放后成功
assert.equal(fs.readFileSync(target, 'utf8'), 'candidate');
```

- [x] **Step 2: 运行并观察模块缺失**

Run: `bun test ./server/tests/durability-primitives.test.js`

Expected: FAIL。

- [x] **Step 3: 实现 Windows 后端**

```js
const k32 = dlopen('kernel32.dll', {
  CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.u64 },
  FlushFileBuffers: { args: [FFIType.u64], returns: FFIType.i32 },
  CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  GetLastError: { args: [], returns: FFIType.u32 },
});

const INVALID_HANDLE = 0xffffffffffffffffn;
const isInvalid = (handle) => BigInt.asUintN(64, BigInt(handle)) === INVALID_HANDLE;
const widePtr = (value) => ptr(Buffer.from(`${value}\0`, 'utf16le'));
```

lease 用 `share = 0` + `OPEN_ALWAYS`；`ERROR_SHARING_VIOLATION (32)` 映射为 `LEASE_BUSY`。目录 fsync 必须请求 `GENERIC_WRITE` 并带 `FILE_FLAG_BACKUP_SEMANTICS`。`atomicReplace` 复用 `fs.renameSync`，把 `EPERM`/`EBUSY`/`EACCES` 归类为可重试，退避后仍失败则抛 `TargetLockedError`。**注意**：传给 FFI 的宽字符 Buffer 必须在调用期间保持引用，避免被 GC 回收。

- [x] **Step 4: 实现 POSIX 后端与能力探测**

POSIX 用 `fs.openSync` + 独占 `flock`（经 `bun:ffi` 调 libc，或在该平台上用 `O_EXLOCK`），目录 fsync 用目录 fd。`detectCapabilities()` 在进程启动时执行一次真实探测（在数据根下建临时文件实测，而不是靠 `process.platform` 推断），结果缓存。

- [x] **Step 5: 启动时强制校验能力**

`server/index.js` 启动序列中，在 `initDatabase()` 之前调用 `detectCapabilities()`；任一能力缺失时打印明确诊断并以非零码退出，不进入服务循环。开发模式下同样拒绝启动——这是防止"本机能跑、用户机器上悄悄退化"的唯一手段。

- [x] **Step 6: 验证编译产物**

Run: `pnpm build:sidecar`

随后用隔离数据根运行编译出的 `mythpen-server`，确认能力探测通过、`/api/health` 返回 200。这一步验证 FFI 在单文件 exe 中仍然可用。

---

### Task 3: 故障注入框架

后续每个任务的验收都依赖它，所以先建。需要两个层次：进程内的命名注入点（快、可精确到某一行之前），以及真实的进程杀死（验证 OS 级恢复语义，lease 回收与部分写入只能这样测）。

**Files:**
- Create: `server/testing/fault-injection.js`
- Create: `server/testing/crash-harness.js`
- Create: `server/tests/fault-injection.test.js`

**Interfaces:**
- `faultPoint(name, context?)` — 生产代码在关键位置调用；未激活时零开销直接返回。
- `withFaults(map, fn)` — 测试内激活，`map` 形如 `{ 'controlstore.append.before-fsync': { throw: 'EIO' } }`；退出时自动清理。
- `runUntilCrash({ script, faults, env })` — 子进程执行脚本，在命名点触发时立刻 `process.kill(process.pid, 'SIGKILL')`，返回崩溃前的耐久化现场路径，供父进程做恢复断言。
- 命名点必须在模块中集中声明为常量，禁止散落字符串字面量。

- [x] **Step 1: 写失败测试**

```js
// 进程内注入
await withFaults({ 'demo.step': { throw: 'EIO' } }, async () => {
  await assert.rejects(() => demoOperation(), { code: 'EIO' });
});
// 未激活时不影响正常路径
assert.equal(await demoOperation(), 'ok');

// 子进程崩溃：文件已写入但未完成重命名
const crash = await runUntilCrash({
  script: 'server/tests/fixtures/crash-demo.js',
  faults: { 'demo.after-temp-write': { crash: true } },
});
assert.equal(crash.signal, 'SIGKILL');
assert.ok(fs.existsSync(crash.artifacts.tempPath));
assert.equal(fs.existsSync(crash.artifacts.targetPath), false);
```

- [x] **Step 2: 运行并观察失败**

Run: `bun test ./server/tests/fault-injection.test.js`

Expected: FAIL。

- [x] **Step 3: 实现注入框架**

激活状态存在模块级 Map 中，`faultPoint()` 先做一次 `size === 0` 短路。子进程 harness 通过环境变量传入序列化的 fault map 与现场输出路径，父进程用 `spawnSync`/`spawn` 收集退出信号。**约束**：`faultPoint` 在生产构建中必须仍然存在（否则测的不是发布代码路径），靠空 Map 短路保证开销可忽略；用一条基准断言守住这一点。

---

### Task 4: ControlStore

**Files:**
- Create: `server/control-store.js`
- Create: `server/tests/control-store.test.js`

**Interfaces:**
- `openControlStore(controlDir): ControlStore`
- `store.append(event): { seq, digest }` — `event = { type, payload, afterPredicate? }`；写入前自动带上 `prevDigest` 与递增 `seq`。
- `store.read(): Event[]` / `store.tail(): Event | null`
- `store.compareAndAppend(expectedDigest, event)` — 摘要不匹配抛 `CONTROL_STORE_CAS_FAILED`。
- 存储位置：`<dataDir>/control/<projectKey>/`，**不在项目数据库内、不在未来的 Git 工作树内**。

- [x] **Step 1: 写失败测试**

覆盖：追加后可读回且顺序稳定；`prevDigest` 链完整；CAS 摘要不匹配被拒绝；在 `before-publish` 与 `before-dir-fsync` 两个注入点崩溃后，日志要么不含该事件、要么完整含该事件，绝不出现半条记录；重新打开后 `seq` 从正确位置继续。

```js
const crash = await runUntilCrash({ script: fixture, faults: { 'controlstore.append.before-publish': { crash: true } } });
const reopened = openControlStore(crash.artifacts.controlDir);
const events = reopened.read();
assert.ok(events.length === 2 || events.length === 3);
assert.ok(events.every((event, index) => index === 0 || event.prevDigest === events[index - 1].digest));
```

- [x] **Step 2: 运行并观察失败**

Run: `bun test ./server/tests/control-store.test.js`

Expected: FAIL。

- [x] **Step 3: 实现只追加事件日志**

每个事件一个文件（`<seq>-<digest>.json`），写同目录临时文件 → `fsyncFile` → `atomicReplace` → `fsyncDirectory`。读取时按 `seq` 排序并校验摘要链，链断裂立刻抛 `CONTROL_STORE_CORRUPT` 而不是跳过。所有落盘走 Task 2 的原语。

---

### Task 5: SqlJsAtomicStore

这一步替换 `server/db.js:57-87` 的 `_flushDb`，是整个 L1 的核心。

**Files:**
- Create: `server/sqljs-atomic-store.js`
- Modify: `server/db.js:57-87,133-238,461-478,964-967`
- Create: `server/tests/sqljs-atomic-store.test.js`

**Interfaces:**
- `createAtomicStore({ filePath, controlStore, sqlModule }): AtomicStore`
- `store.publish(database)` — 导出候选 → 写临时文件 + fsync → 重开候选执行 `PRAGMA integrity_check` 与 `foreign_key_check` → 原子替换 → 目录 fsync → 重开正式库验证 → 安装 `connectionEpoch + 1`。
- `store.connectionEpoch` / `store.assertEpoch(epoch)` — 过期句柄操作抛 `DB_CONNECTION_STALE`。
- `store.recover()` — 依据 ControlStore 的 before/after 证据前滚或回滚；无法形成精确组合时返回 `RECOVERY_REQUIRED` 并拒绝后续连接。

- [x] **Step 1: 写失败测试**

```js
// 正式库永远是完整的 before 或 after 之一
for (const point of ['before-candidate-write', 'after-candidate-write', 'before-replace', 'after-replace', 'before-epoch-install']) {
  const crash = await runUntilCrash({ script: fixture, faults: { [`atomicstore.publish.${point}`]: { crash: true } } });
  const bytes = fs.readFileSync(crash.artifacts.dbPath);
  assert.ok(equalsBefore(bytes) || equalsAfter(bytes), `${point} 产生了第三种状态`);
  assert.doesNotThrow(() => openAndIntegrityCheck(bytes));
}

// 候选校验失败时不发布
await withFaults({ 'atomicstore.publish.corrupt-candidate': { active: true } }, async () => {
  await assert.rejects(() => store.publish(database), { code: 'CANDIDATE_VERIFICATION_FAILED' });
  assert.deepEqual(fs.readFileSync(dbPath), beforeBytes);
});

// 旧 epoch 句柄不得回写
const stale = store.currentConnection();
store.publish(database);
assert.throws(() => stale.run("INSERT INTO chapters (num, title) VALUES (1, 'x')"), { code: 'DB_CONNECTION_STALE' });

// 覆盖全部项目表，不只是章节
assert.deepEqual(readAll('characters'), expectedCharacters);
assert.deepEqual(readAll('chat_messages'), expectedMessages);
```

- [x] **Step 2: 运行并观察失败**

Run: `bun test ./server/tests/sqljs-atomic-store.test.js`

Expected: FAIL。

- [x] **Step 3: 实现发布协议**

保留现有 `_flushDb` 中在 `export()` 之后恢复 `PRAGMA foreign_keys = ON` 的处理（`server/db.js:70-79`，sql.js 的已知行为），把 `fs.writeFileSync` 替换为完整发布流程。ControlStore 记录 before 文件身份/哈希、候选位置/哈希、after 谓词。

- [x] **Step 4: 接入 `_wrapDb` 与连接缓存**

`_scheduleFlush` / `_flushSync` 改为经 `AtomicStore.publish`。250ms 防抖保留（它是性能手段，不是安全手段），但 `transaction()` 的提交后立即发布必须保持同步语义。`projectConnections` 的每个条目持有自己的 store 与 epoch。

- [x] **Step 5: 守住"不长期持有正式库句柄"**

新增测试断言：发布期间进程内不存在指向正式 `.db` 的打开句柄——否则会命中 Task 2 已确认的 `EPERM` 失败模式。sql.js 是整文件读入内存后关闭，天然满足，但需要回归测试防止将来引入流式读取时悄悄破坏。

- [x] **Step 6: 全量回归**

Run: `bun test ./server/tests/`

Expected: 全绿。特别关注 `db-flush-foreign-keys`、`project-db-existence`、`chapter-*` 这几组既有测试。

---

### Task 6: 跨进程 writer lease 与写入队列

> **状态：正确性基础已完成，完整性能验收延期。** Step 4 的基准已经执行并记录，但 3,000 章目标未达到；经用户批准，native SQLite/性能重构与 POSIX missing-formal verified install 延后处理。

**Files:**
- Create: `server/project-write-coordinator.js`
- Modify: `server/db.js`（`getProjectDb`/`projectExecute`/`projectTransaction` 接入协调器）
- Modify: `server/index.js`（启动时恢复未完成 journal）
- Create: `server/tests/project-write-coordinator.test.js`

**Interfaces:**
- `withProjectWrite(projectKey, fn)` — 依次取得 `OS lease → 进程内 FIFO`，执行前先恢复 ControlStore 中的未完成记录，结束后释放。
- lease 文件位于**稳定应用控制根**（`<dataDir>/locks/<projectKey>.lease`），与项目资产分离，为 L2/L3 的归档搬迁预留空间。
- 错误：`PROJECT_WRITE_BUSY`（获取失败）、`WRITER_LEASE_LOST`（持有期间句柄失效，必须立即停止后续副作用）。

- [x] **Step 1: 写失败测试**

覆盖：两个进程竞争同一项目 lease，后者得到 `PROJECT_WRITE_BUSY`；持有者被 `SIGKILL` 后新进程可立即获取并先恢复 journal；同进程内并发写入按 FIFO 严格串行（用注入点制造交错，断言顺序）；lease 中途失效时不产生任何后续文件副作用；不同项目的 lease 互不阻塞。

- [x] **Step 2: 运行并观察失败**

Run: `bun test ./server/tests/project-write-coordinator.test.js`

Expected: FAIL。

- [x] **Step 3: 实现协调器并接入写路径**

`projectExecute` / `projectTransaction` / `createProjectDb` / 迁移路径全部包进 `withProjectWrite`。读路径此阶段不取 lease（读一致性属于 L2 的 `ensureReadableProjection`）。

- [x] **Step 4: 记录基线性能**

Run: 新增 `server/tests/durability-benchmark.test.js`，测量单次章节保存的端到端耗时与全库发布耗时，把数值写入 `docs/superpowers/plans/l1-benchmarks.md`。

范围文档给出的初始目标是自动保存 p95 < 300ms、全库发布 p95 < 500ms（3,000 章项目）。**若超标，先改设计再继续 Task 7**，不接受"先实现后优化"。

---

### Task 7: ManuscriptService 收口正文写入

> **状态：已完成。** 正文写入调用方已完成迁移，静态写入守卫与最终独立审查均通过。

当前 `chapters.content` 有 5 条直写路径，它们各自做 CAS、各自决定何时落盘。收口后只剩一个出口，为 L2 的文件权威层预留唯一接入点。

**Files:**
- Create: `server/manuscript-service.js`
- Modify: `server/routes/api.js:531`（章节 PUT）
- Modify: `server/tools.js:869-903`（`create_chapter` / `update_chapter`）
- Modify: `server/ai-continue-save.js:57`
- Modify: `server/chapter-revisions.js:251`（接受提案）
- Create: `server/tests/manuscript-service.test.js`

**Interfaces:**
- `manuscriptService.writeChapterBody({ projectName, chapterId, content, expectedDataVersion, source })`
- `manuscriptService.appendChapterBody({ projectName, chapterId, appended, expectedBodyHash, source })`
- `manuscriptService.createChapter({ projectName, fields, source })`
- 全部内部经由 `withProjectWrite` + `SqlJsAtomicStore`，并记录 `source`（`rest` / `ai_tool` / `ai_continue` / `revision_accept`）供诊断。

- [x] **Step 1: 写失败测试**

断言四类调用方产生逐字节一致的持久化结果与同一套 CAS 语义；断言 `chapters.content` 的直写在代码中已不存在（用一条静态检查测试扫描 `server/**/*.js`，允许清单只含 `manuscript-service.js` 与 `db.js` 的迁移代码）。

```js
const offenders = findDirectContentWrites(['server']);
assert.deepEqual(offenders, ['server/manuscript-service.js', 'server/db.js']);
```

- [x] **Step 2: 运行并观察失败**

Run: `bun test ./server/tests/manuscript-service.test.js`

Expected: FAIL，静态检查列出 5 个调用点。

- [x] **Step 3: 实现服务并逐个迁移调用方**

保持现有 `expected_data_version` 乐观锁语义与 `chapter_revisions` 的 CAS 行为不变——L1 不改业务契约。每迁移一个调用方就跑一次该调用方的既有测试。

- [x] **Step 4: 全量回归**

Run: `bun test ./server/tests/`；`pnpm test:client`；`pnpm typecheck`

Expected: 全部 exit 0。

---

### Task 8: 诊断与修复入口

> **状态：实现与本地验收已完成；对外发布未授权。** 只读诊断、项目隔离、固定 API/UI、D9/D10 均已实现并通过逐任务独立复审；服务端现场矩阵、五个真实 Desktop 生命周期场景和 RecoveryNotice 真实 UI 已通过。`slow_drain_cancel` 已根据生产中零异步 admission 的事实收敛为结构上不适用，并由构建扫描门禁防回归。installer、tag、release 暂不执行，也不阻塞 Stage B/C。当前执行与证据以 `2026-08-10-l1-durability-stage-a-compatibility-release.md` 和 `l1-stage-a-acceptance.md` 为准；以下步骤仅保留为原始历史基线，不机械勾选。

范围文档的硬性约束：任何不可自动收敛的终态都必须有出口。这是 L1 的最后一块，也是与用户直接相关的一块。

**Files:**
- Create: `server/recovery-diagnostics.js`
- Modify: `server/routes/api.js`（新增诊断路由）
- Create: `src/components/RecoveryNotice.tsx`
- Modify: `src/pages/...`（在项目打开失败路径上呈现）
- Modify: `src/i18n/zh.json`、`src/i18n/en.json`
- Create: `server/tests/recovery-diagnostics.test.js`
- Create: `tests/recoveryNotice.test.ts`

**Interfaces:**
- `GET /:project/diagnostics` — 返回 `{ state, controlStoreTail, dbIdentity, capabilities, canForwardRecover, canRollback }`
- `POST /:project/diagnostics/export` — 生成诊断包（ControlStore 事件、文件身份与哈希、能力探测结果；**不含正文内容**）到导出目录，返回 opaque 文件名。
- `POST /:project/diagnostics/recover` — 仅在能证明安全时执行前滚或回滚；否则返回结构化拒绝原因。

- [ ] **Step 1: 写失败测试**

构造三种现场：可前滚（正式库等于 before 且候选完整）、可回滚（候选不完整且 before 副本完整）、不可判定（第三种字节状态）。断言前两种能自动收敛且数据正确，第三种保留现场、返回 `RECOVERY_REQUIRED`、诊断包可导出、且**不执行任何覆盖**。

- [ ] **Step 2: 运行并观察失败**

Run: `bun test ./server/tests/recovery-diagnostics.test.js`

Expected: FAIL。

- [ ] **Step 3: 实现诊断与恢复**

恢复逻辑复用 Task 5 的 `store.recover()`，路由只做包装与鉴权。诊断包不包含正文，避免用户把稿件内容发给他人排障。

- [ ] **Step 4: 实现前端提示**

项目打开失败且原因为 `RECOVERY_REQUIRED` 时，展示状态说明、"尝试自动恢复"与"导出诊断包"两个动作，以及明确的"不要手动删除文件"提示。走既有确认对话框模式，不新增设计语言。

- [ ] **Step 5: 最终验收**

Run: `bun test ./server/tests/`；`pnpm test:client`；`pnpm typecheck`；`pnpm lint`

Expected: 全部 exit 0。

- [ ] **Step 6: 手工验收**

1. 正常使用一个项目，写作、保存、切换章节，确认无可感知的性能退化。
2. 用编辑器打开项目 `.db` 文件保持占用，触发一次保存，确认得到可理解的重试/失败提示而不是崩溃或静默丢数据。
3. 在保存过程中强制结束进程（任务管理器），重启应用，确认项目可正常打开且数据完整。
4. 手工把 `.db` 截断成半个文件，确认应用进入 `RECOVERY_REQUIRED` 并能导出诊断包，且不会覆盖现场。
5. 同时启动应用与 `mythpen-cli`，确认后者得到 `PROJECT_WRITE_BUSY` 而不是并发写坏数据库。

- [ ] **Step 7: 检查最终 diff**

Run: `git diff --check; git status --short`

Expected: 无空白错误，只包含本计划涉及的文件与既有未跟踪的 skill 目录。

---

## 完整 L1 完成定义（当前未满足）

- 在发布协议的每个阶段注入崩溃，正式数据库始终是完整的 before 或 after 之一，且 `integrity_check` 与 `foreign_key_check` 通过。
- 两个进程无法同时写同一项目；持有者崩溃后 lease 由 OS 释放，下一进程先恢复 journal 再继续。
- `chapters.content` 不存在任何绕过 `ManuscriptService` 的写入路径。
- 平台能力缺失时应用拒绝启动并给出明确原因，绝不退化为旧的直接覆写。
- 服务端测试在 Bun 单进程内全绿，且开发、测试、生产三处运行时一致。
- 性能基线已记录且满足范围文档的初始目标。
