# Mythpen 可测试 EXE 构建 Skill 设计

## 背景

Mythpen 的 Windows 桌面程序由 Tauri 打包。完整构建不仅包含前端，还会通过
`src-tauri/tauri.conf.json` 中的 `beforeBuildCommand` 构建
`mythpen-server` 与 `mythpen-cli` 两个 sidecar。当前流程要求 Bun `1.3.14`，
并依赖 Node.js、pnpm、Rust 与本地项目依赖。

用户希望以后说“测试程序完成得怎么样”“构建测试版 EXE”等话时，Agent 能自动完成
一次可供人工测试的 Windows 构建，并明确报告本次生成的程序和安装包，而不是只给出
手工命令或误报旧产物。

## 目标

- 在仓库的 `.codex/skills` 中提供可自动发现的项目级 Skill。
- 用确定性的 PowerShell 脚本执行预检、测试、构建和产物校验。
- 生成可在当前构建目录直接运行的 `mythpen.exe`、NSIS 安装程序和 MSI。
- 报告构建所对应的 Git 状态以及产物绝对路径、大小、时间和 SHA-256。
- 对缺失工具、版本错误、测试失败、构建失败和陈旧产物给出明确错误。
- 保留当前已知的 Biome 债务，不把 `pnpm lint` 纳入测试版构建门禁。

## 非目标

- 不自动启动或安装构建产物。
- 不修改应用版本号。
- 不提交、打 Tag、推送或创建 GitHub Release。
- 不替代 `.codex/skills/mythpen-release` 的正式发布流程。
- 不修复构建过程中发现的产品代码或既有 lint 问题。
- 不把单独复制的 `src-tauri/target/release/mythpen.exe` 描述为便携版；它应在原构建
  目录中与 sidecar 一起使用。

## 目录结构

新 Skill 使用以下结构：

```text
.codex/skills/build-mythpen-test-exe/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    └── build-test-exe.ps1
```

`SKILL.md` 负责触发条件、Agent 行为边界和失败处理。PowerShell 脚本负责所有需要
稳定复现的本地检查与构建步骤。`agents/openai.yaml` 提供与 Skill 内容一致的界面元数据。

## 触发与行为边界

Skill 名称为 `build-mythpen-test-exe`。描述应覆盖 Mythpen 仓库中的以下意图及近义表达：

- 测试程序完成得怎么样；
- 构建、编译或重新打包可测试的 EXE；
- 生成 Windows 测试安装包；
- 准备一个桌面程序供人工验收。

触发后默认立即构建，不再询问是否启动。Agent 必须明确区分本 Skill 与正式发布：
即使当前分支有未提交修改，也可以构建供测试，但不得借此执行版本更新、提交、Tag 或推送。

## 构建流程

Agent 从 Mythpen 仓库根目录调用脚本。脚本依次执行：

1. 校验当前目录包含 `package.json`、`src-tauri/tauri.conf.json` 和
   `scripts/build-sidecars.mjs`。
2. 记录构建开始时间、当前提交短哈希、分支名和工作区是否有修改。脏工作区不阻止
   测试构建，但最终报告必须说明产物包含未提交改动。
3. 检查 `node`、`pnpm`、`bun`、`rustc` 和 `cargo` 可执行；Bun 版本必须精确为
   `1.3.14`。
4. 如果本地依赖尚未安装，执行 `pnpm install --frozen-lockfile`；不得修改锁文件。
5. 执行 `pnpm test:server`。
6. 直接调用仓库内的 TypeScript 编译器：

   ```powershell
   node node_modules/typescript/bin/tsc --project tsconfig.app.json --noEmit
   ```

   这样不会错误解析到系统中较旧的全局 TypeScript。
7. 执行一次 `pnpm tauri build`。该命令已经通过 Tauri 配置自动执行
   `pnpm build` 和 `pnpm build:sidecar`，不得再单独重复构建 sidecar。
8. 校验当前版本的三个用户产物：
   - `src-tauri/target/release/mythpen.exe`
   - `src-tauri/target/release/bundle/nsis/*-setup.exe`
   - `src-tauri/target/release/bundle/msi/*.msi`
9. 为每个产物计算 SHA-256，并输出绝对路径、字节数和 UTC 修改时间。

脚本任一步失败都以非零状态退出。只有测试、类型检查、Tauri 构建和三个产物校验全部
成功时，Agent 才能告诉用户“可测试程序已构建完成”。

## 产物归属校验

只有当前 `pnpm tauri build` 成功退出后，脚本才检查产物。Cargo 的增量构建可以合法
复用与当前源码一致、修改时间早于脚本开始时间的二进制，因此不能把修改时间作为唯一的
新鲜度判据，也不能为了更新时间而清理整个构建缓存。

脚本从 `src-tauri/tauri.conf.json` 读取当前版本，并在 NSIS、MSI 的固定目录中分别要求
存在且只存在一个与当前版本匹配的候选；文件名不得硬编码 `0.0.10`。固定路径的
`mythpen.exe` 以及两个当前版本安装包都必须非空。脚本同时记录构建前后的大小、修改时间
与 SHA-256；产物未变化时明确标为“增量构建复用”，而不是伪称本次重新写入。

如果构建失败，即使目录中存在旧产物也不得继续产物校验或报告成功。

## 错误处理

- 工具缺失或版本不符：停止并指出实际版本与所需版本。
- 依赖安装失败：保留原始命令错误，不继续测试或构建。
- 测试或类型检查失败：停止构建，报告失败阶段。
- `pnpm tauri build` 失败：不报告任何旧安装包为成功。
- 在受限环境中遇到 `spawn EPERM`、`spawnSync rustc EPERM` 等权限错误：Agent 应对
  原始失败命令申请沙箱外重试，不得跳过对应门禁。
- 产物校验失败：报告缺失或陈旧的具体路径，并保持非零退出状态。

脚本不自行提权，也不吞掉子命令输出；是否进行沙箱外重试由调用它的 Agent 按当前运行
环境处理。

## 最终报告

成功报告必须包含：

- 当前提交和工作区干净/脏状态；
- 服务端测试、TypeScript 检查和完整 Tauri 构建均已通过；
- 原始桌面程序、NSIS 和 MSI 的绝对路径；
- 每个产物的大小、修改时间和 SHA-256；
- “未自动启动或安装”的说明。

失败报告必须包含失败阶段、原始错误摘要和下一项可执行处理。没有通过最终产物校验时，
不得提供容易被理解为本次可测试版本的成功结论。

## 验证策略

Skill 按文档型 TDD 验证：

1. 在 Skill 写入前，让不了解拟定流程的 Agent 处理“给我构建一个 Mythpen 测试 EXE”，
   记录其是否遗漏 sidecar、Bun 固定版本、完整类型检查、产物新鲜度或发布边界。
2. 初始化并编写最小 Skill 和脚本，针对基线遗漏补足明确约束。
3. 运行 Skill 结构校验工具。
4. 实际运行 PowerShell 脚本，完成一次 Windows 构建并检查输出。
5. 让新的 Agent 使用 Skill 处理等价请求，确认其调用脚本、正确解释产物且不启动、
   安装或发布。

现有 Biome 检查债务不纳入本功能验收，因此验证不运行 `pnpm lint`。

## 验收标准

- Codex 能通过用户的自然语言测试构建请求发现该 Skill。
- Skill 能自动完成预检、服务端测试、完整 TypeScript 检查和 `pnpm tauri build`。
- Bun 非 `1.3.14` 时构建在 sidecar 阶段之前明确失败。
- 只有当前构建命令成功后校验通过且非空的 EXE、NSIS 和 MSI 才被报告。
- 成功报告可让用户直接定位待测程序和两个安装包。
- 构建包含未提交修改时，报告不会误导用户把它当作某个纯提交构建。
- 整个流程不运行 lint、不启动程序、不安装程序，也不改变 Git 历史或远端状态。
