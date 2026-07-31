---
name: build-mythpen-test-exe
description: Use when working in the Mythpen repository and the user asks “测试程序完成得怎么样”, requests a testable Windows EXE or installer, or asks to rebuild, package, or compile the desktop application for manual acceptance.
---

# 构建 Mythpen 测试 EXE

## 核心规则

从当前工作树构建，不要求工作区干净。只有脚本以成功状态结束时，才能告诉用户测试程序已完成。

## 执行

1. 确认当前仓库是 Mythpen，并取得仓库根目录。
2. 从仓库根目录运行：

   ```powershell
   $repo = (git rev-parse --show-toplevel).Trim()
   & (Join-Path $repo '.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1') -RepositoryRoot $repo
   ```

3. 如果受限环境返回 `spawn EPERM`、`spawnSync rustc EPERM` 或等价权限错误，对同一脚本申请沙箱外重试。不得跳过测试、类型检查或构建阶段。
4. 脚本失败时报告失败阶段和原始错误摘要，不得把已有产物描述为本次成功。

## 成功报告

按以下顺序给出结果：

1. 当前提交、分支以及工作区是否包含未提交修改。
2. 服务端测试、完整 TypeScript 检查和 Tauri 构建均已通过。
3. `desktop`、`nsis`、`msi` 三条产物记录的绝对路径、大小、UTC 修改时间、SHA-256 和 `written/reused` 状态。
4. 明确说明没有自动启动或安装程序。

`src-tauri/target/release/mythpen.exe` 只能在原构建目录中与 sidecar 配合测试，不要把单独复制的文件称为便携版。

## 边界

- 不运行 `pnpm lint`。
- 除非用户在当前请求中另有明确要求，不启动或安装产物。
- 不修改版本号，不提交、打 Tag、推送或创建 Release。
- 不调用 `mythpen-release`；正式发布是另一个工作流。

## 常见错误

| 错误 | 正确处理 |
|---|---|
| 单独运行 `pnpm build:sidecar` 后宣称桌面程序完成 | 运行完整脚本；Tauri 构建会自动构建 sidecar |
| 只看到旧安装包存在就报告成功 | 当前脚本和 Tauri 命令必须成功 |
| 因增量产物时间较早而强制清理缓存 | 接受脚本报告的 `reused`，不要运行全量 clean |
| 为得到“干净结果”顺手修 lint 或提交代码 | 保持工作树原样并在报告中说明 |
