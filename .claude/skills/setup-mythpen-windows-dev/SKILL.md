---
name: setup-mythpen-windows-dev
description: Use when setting up, repairing, validating, or starting Mythpen's Windows development environment, including Vite/Express browser development, Tauri desktop development, local port conflicts, toolchain checks, or spawn EPERM failures.
---

# 配置 Mythpen Windows 开发环境

## 核心原则

默认使用隔离的开发数据，并让开发服务留在可见、可控的前台终端中。`pnpm dev:all` 会重建名为“我的科幻小说”的种子项目；看到启动日志不等于环境可用，必须完成实际 HTTP 验收。

## 1. 先确认模式与现状

从仓库根目录检查工作区、工具链与端口。不要为抢占端口停止未知进程。

```powershell
git status --short --branch
node --version
pnpm --version
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 3001, 5173 } |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

- 浏览器模式是默认选择：Vite 前端通常在 `5173`，Express API 在 `3001`。
- 若两个端口已被 Mythpen 占用，先请求 `http://localhost:3001/api/health`；健康且符合当前需求时复用它，不要再启动一套。
- 若监听者未知，读取 PID 的命令行后让用户决定；只清理由当前任务明确启动的进程树。
- 桌面模式仅在用户明确需要 Tauri 窗口时使用；它的 `devUrl` 固定为 `http://localhost:5173`。

## 2. 准备依赖

浏览器开发需要 Node.js 20+ 和项目锁定的 pnpm；新检出或依赖不可信时执行：

```powershell
pnpm install --frozen-lockfile
```

`package.json` 固定 `pnpm@10.10.0`。Bun `1.3.14` 用于 `build:sidecar`/桌面打包，不是普通浏览器开发的前置条件。Tauri 开发还需要 Rust/MSVC；若找不到 `cl` 或 `link`，改用 Developer PowerShell for Visual Studio。

受限环境出现 `spawn EPERM`、原生模块读取异常或 Vite 子进程失败时，用同一条命令在获准的受限环境外重试。不要据此修改业务代码、降级依赖或把沙箱失败当成项目失败。

## 3. 启动浏览器开发模式

除非用户明确要求使用现有数据，先隔离数据目录：

```powershell
$mythpenDevDataDir = Join-Path $env:LOCALAPPDATA 'Mythpen-dev'
$env:MYTHPEN_DATA_DIR = $mythpenDevDataDir
pnpm dev:all
```

保持该终端运行。`dev:all` 先执行种子脚本，再同时启动 Vite 与 nodemon/Express；不要只运行 `pnpm dev`，否则前端代理没有后端 API。

如果必须连接现有数据，先得到用户确认，并在两个受控终端分别启动 `pnpm dev` 与 `pnpm dev:server`，避免种子脚本覆盖同名示例项目。

## 4. 启动桌面开发模式

沿用同一个 `MYTHPEN_DATA_DIR`，然后只运行：

```powershell
pnpm tauri dev
```

不要另开 `pnpm dev:all`：`src-tauri/tauri.conf.json` 的 `beforeDevCommand` 已会启动它。若 Vite 因 `5173` 被占用而自动改到其他端口，先处理端口冲突；Tauri 不会自动跟随该备用端口。

## 5. 验收并报告

在服务仍运行时逐条执行：

```powershell
Invoke-RestMethod http://localhost:3001/api/health
Invoke-WebRequest http://localhost:5173/ -UseBasicParsing
Invoke-RestMethod http://localhost:5173/api/health
pnpm test:server
pnpm typecheck
pnpm build
```

前两条确认 API 与页面，第三条确认 Vite 代理。报告实际端口、模式、隔离数据目录以及每项命令的新鲜结果。不要把 `pnpm lint` 当作只读验收：当前脚本包含 `--write`，会改动 `src/`。

## 边界

- 普通开发环境不运行 `pnpm tauri build`、安装包或发布流程；人工验收安装包使用 `build-mythpen-test-exe`。
- 不修改版本号、不提交、不推送，也不为了“干净”而重置用户已有改动。
- 自动化壳退出后，仍须以端口和 HTTP 响应确认服务是否存活；临时探针结束时只关闭自己记录的进程树。
