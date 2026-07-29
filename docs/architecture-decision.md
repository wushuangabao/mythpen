# 架构决策记录

## 后端架构演进

### 当前架构

```
Tauri (Rust + WebView)
  └─ sidecar: bun --compile → Express 服务器 (Node.js)
       └─ sql.js (WASM 版 SQLite)
            └─ ~/.mythpen/config.db  +  ~/.mythpen/projects/*.mythpen.db
```

### 关键决策：为什么用 sidecar + HTTP API

Mythpen 最初选择 Express sidecar 而非 Tauri 原生 SQLite，主要基于以下考量：

| 需求 | sidecar HTTP | Tauri IPC |
|---|---|---|
| **可调试性** | ✅ `curl` / Chrome DevTools Network 面板 / Claude Code 均可直接调用 API | ❌ 必须启动完整 Tauri 环境 |
| **前后端分离** | ✅ 可独立启动后端（`node server/index.js`）配合前端开发 | ❌ 必须编译整个应用 |
| **快速迭代** | ✅ 改后端代码即时生效（nodemon 热重载） | ❌ 改 Rust 需重新编译 |
| **浏览器兼容** | ✅ `ServerStatusGate` 可作为独立 Web 应用运行验证 | ❌ 无法在浏览器中测试 |

### 数据层选型历程

```
better-sqlite3 (Node.js 原生扩展)
    ↓  bun --compile 不支持 .node 原生扩展
sql.js (WASM 版 SQLite, 纯 JS)
    ↓  WASM 文件嵌入问题
base64 内联 wasm-binary.js（当前方案）
```

---

## "Load failed" Bug 完整复盘

### 症状

App 启动后卡在 Mythpen 启动页 → 几秒后显示 "Load failed"（`服务器启动失败`）。后台 Express 服务器从未成功监听 3001 端口。

### 系统启动链路

```
Tauri 启动
  → Rust setup()  spawn sidecar (mythpen-server 二进制)
  → 后台线程等待 :3001 可达（最长 30s）
  → 前端 WebView 显示启动页
       ↓
  ServerStatusGate 轮询 GET /api/health（指数退避，最多 20 次 ≈ 60s）
       ↓
  多次超时后 → 显示 "服务器启动失败" (Load failed)
```

断链点：**sidecar 内部从未完成初始化**。

### 根因

`sql.js` 需要加载 `sql-wasm.wasm`（660KB 的 SQLite C 编译产物）才能初始化数据库：

```
C 写的 SQLite 引擎
       ↓  编译成
WebAssembly 字节码 (.wasm)
       ↓  由 sql.js 加载
JavaScript 可调用的 SQLite 接口
       ↓
db.query('SELECT * FROM chapters')
```

在没有 `node_modules` 的 bun --compile 二进制中，WASM 必须通过其他方式加载。`server/db.js` 原设计有多层 fallback：

1. `require('./sql-wasm.wasm')` — bun --compile 时内联
2. `fs.readFileSync(__dirname + '/sql-wasm.wasm')` — 开发环境
3. `fs.readFileSync(CWD + '/server/sql-wasm.wasm')` — 兜底

在 macOS `.app` 包内运行二进制时，**所有 fallback 均失败**。

### 修复历程（三次迭代）

#### 🔴 第 1 轮：CI 构建缺失 `--assets`

**提交** `45deb7f`

- 问题：CI 的 `build.yml` 中 `bun build --compile` 未加 `--assets` 参数，且未预复制 WASM 文件
- 修复：添加 `node scripts/copy-wasm.mjs` 和 `--assets server/sql-wasm.wasm`
- 结果：CI 构建成功，但发布的二进制仍然卡启动页

#### 🔴 第 2 轮：bun 1.3.14 `--assets` 自身有 Bug

**排查发现：**

- 任何加 `--assets` 编译的二进制在 macOS 上**启动即静默崩溃**
- 二进制 exit code 0，无任何 stdout/stderr 输出
- **这是 bun 1.3.14 的 Bug**：`--assets` 导致 JavaScript 入口代码执行前崩溃
- 验证脚本：无 `--assets` → 正常输出；有 `--assets` → 静默退出

#### ✅ 第 3 轮：base64 内联，彻底弃用 `--assets`

**提交** `5bda669`

- 新建 `scripts/embed-wasm.mjs`：从 `node_modules/sql.js` 读取 WASM，转为 base64，写入 `server/wasm-binary.js`
- `server/wasm-binary.js`：880KB 纯 JS 模块，内含 `atob()` 解码逻辑
- `server/db.js` 策略 1 改为 `require('./wasm-binary').getWasmBinary()`
- CI 和本地构建全部移除 `--assets`
- 本地验证：21ms 启动，health check 正常返回

**完整的 WASM 加载流：**

```
embed-wasm.mjs（构建时）
  sql-wasm.wasm → base64 → wasm-binary.js
  
db.js 初始化时：
  require('./wasm-binary') → getWasmBinary()
    → atob() 解码 → Uint8Array → initSqlJs({ wasmBinary })
    → SQLite 就绪
```

### 经验教训

| 问题 | 教训 |
|---|---|
| CI 构建参数与本地不一致 | CI 步骤必须逐字复制本地已验证的命令，无任何差异 |
| bun `--assets` 静默崩溃 | 二进制冒烟测试应作为 CI 标准步骤（构建后立即运行验证） |
| WASM 加载跨环境脆弱 | base64 内联是跨运行时最鲁棒的方式（Node / bun dev / bun --compile 均一致） |
| 修复验证不充分 | "构建成功" 不等于 "运行正常"，必须端到端验证二进制行为 |

---

## 架构权衡分析

### 方案 A：保持当前架构（sidecar + Express + sql.js base64）

**现状，已修复。**

```
Tauri (Rust + WebView)
  └─ sidecar: bun --compile → Express 服务器
       └─ sql.js → wasm-binary.js (base64 内联)
            └─ SQLite 数据库
```

**优点：**
- 可用 `curl` / Chrome DevTools Network 面板调试 API
- 前后端可独立开发、测试
- Claude Code 等 AI 工具可直接调用 HTTP 接口
- 适合增量开发和快速迭代

**剩余风险：**
- 异步 flush（250ms debounce），崩溃时丢最后 ~250ms 数据
- 跨三层调试（Rust → Node.js → WASM）

### 方案 B：Tauri 原生 SQLite（不建议）

```
Tauri (Rust + WebView)
  └─ tauri-plugin-sql + rusqlite
       └─ SQLite 数据库
```

**优点：**
- 无 sidecar、无 WASM、无 bun 依赖
- 启动即时（无需等待 health check）
- 数据安全（Rust 同步写入）
- 包体积 65MB → ~18MB

**代价：**
- ❌ 无法用 `curl` 调试 API
- ❌ Chrome DevTools Network 面板不可见 IPC 调用
- ❌ Claude Code 无法直接操作数据库
- ❌ 前后端必须整体编译
- 迁移需将 `server/routes/api.js` 全部重写为 Rust（约 2-3 天）

**结论：对本项目而言收益不足以覆盖代价。**

### 方案 C：better-sqlite3（未来可选路径）

```
Tauri → sidecar (Node.js SEA) → better-sqlite3 (原生扩展)
```

保持 sidecar 架构不变，将 sql.js 换为 `better-sqlite3`（同步写入、无 WASM）。关键在于找到 bun --compile 之外可靠的打包方式（如 Node.js Single Executable Application），因为 bun --compile 不支持 `.node` 原生扩展。

**触发条件：** 如果未来 bun 的兼容性再次出现问题，或 sql.js 的异步写入风险变得不可接受。

---

---

## 跨端应用调试策略

Claude Code 无法直接调用 Tauri IPC 或 Electron 主进程，但只要应用暴露一个 **HTTP 接口**，CC 就能像对待任何后端服务一样调试。

### 方案：Debug HTTP 桥

在 Tauri/Electron 中额外起一个 **仅在开发模式下启用的 HTTP 调试服务器**，将 IPC 调用以 HTTP 方式暴露：

**Tauri（Rust 侧）：**

```rust
#[cfg(debug_assertions)]
fn start_debug_server() -> Option<tokio::task::JoinHandle<()>> {
    Some(tokio::spawn(async {
        let app = axum::Router::new()
            .route("/debug/invoke", post(|body: String| async move {
                // 转发到 Tauri invoke handler，返回 JSON
                // ...
            }))
            .route("/debug/state", get(|| async { /* 返回当前状态快照 */ }));
        axum::Server::bind(&"127.0.0.1:9876".parse().unwrap())
            .serve(app.into_make_service())
            .await
            .ok();
    }))
}
```

**Electron（main process）：**

```javascript
if (process.env.NODE_ENV === 'development') {
  const express = require('express');
  const app = express();
  app.post('/debug/ipc', (req, res) => {
    // 转发到 IPC handler
    mainWindow.webContents.send(req.body.channel, req.body.args);
    res.json({ ok: true });
  });
  app.listen(9876);
}
```

### 各架构对 CC 的可调试性

| 架构 | 调试方式 | CC 适配度 |
|---|---|---|
| **sidecar HTTP（Mythpen 当前）** | `curl localhost:3001/api/*` | ⭐⭐⭐⭐⭐ 原生支持 |
| **Tauri IPC + debug 桥** | `curl localhost:9876/debug/invoke` | ⭐⭐⭐⭐ 需维护桥代码 |
| **Electron + webContents debug** | CDP 协议 + `--remote-debugging-port` | ⭐⭐⭐⭐ DevTools MCP 可用 |
| **Tauri IPC 纯（无桥）** | 只能读控制台日志 | ⭐⭐ 不推荐 |

### 对 Mythpen 的启发

当前 sidecar HTTP 架构对 CC 最友好，无需修改。如果未来真的迁移到 Tauri 原生 SQLite，**一定要保留这个 debug 桥**，否则会失去 CLI 调试能力，所有数据层问题都只能靠猜。

---

## 数据安全说明

当前 sql.js 采用 debounce 写入机制（250ms 延迟批量 flush）。SQLite 自身的 WAL 日志机制提供了额外的保护。

| 场景 | 数据安全 |
|---|---|
| 正常退出 | ✅ `runEvent::Exit` → HTTP `/api/shutdown` → flush + close |
| 突发崩溃 | ⚠️ 丢 ~250ms 的未持久化写入（约 1-2 条操作） |
| 数据文件损坏 | ✅ 用户可删除 `~/.mythpen/config.db` 重建（项目数据在 `.mythpen/projects/` 中） |
| 定期备份 | 建议用户手动备份 `~/.mythpen/` 目录 |
