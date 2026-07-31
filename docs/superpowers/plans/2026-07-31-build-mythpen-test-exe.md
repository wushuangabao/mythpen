# Mythpen Test EXE Build Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repository-local Skill that automatically builds and verifies a testable Mythpen Windows EXE, NSIS installer, and MSI without launching, installing, or publishing them.

**Architecture:** A concise `SKILL.md` owns discovery, execution boundaries, and the user-facing report contract. A deterministic PowerShell 5.1 script owns toolchain validation, dependency setup, tests, type checking, the single Tauri build, and artifact identity/hash reporting; `agents/openai.yaml` is generated from the Skill metadata.

**Tech Stack:** Codex repository-local Skills, PowerShell 5.1, Node.js, pnpm 10.10.0, Bun 1.3.14, Rust/Cargo, Tauri 2, Python-based Skill scaffolding/validation.

## Global Constraints

- Create the Skill at `.codex/skills/build-mythpen-test-exe`.
- Treat Bun `1.3.14` as an exact required version.
- Run `pnpm test:server` and `node node_modules/typescript/bin/tsc --project tsconfig.app.json --noEmit`.
- Run `pnpm tauri build` exactly once; do not separately repeat `pnpm build:sidecar`.
- Do not run `pnpm lint`; existing Biome debt is outside this acceptance gate.
- Do not automatically launch or install any artifact.
- Do not modify application versions, commit/tag/push as part of the Skill, or invoke the release Skill.
- Allow dirty working trees but report that the artifact includes uncommitted changes.
- Do not classify an incremental-build cache reuse as failure solely because its modification time predates the current invocation.
- Never report success unless the current Tauri command succeeded and the desktop EXE, current-version NSIS installer, and current-version MSI are unique and non-empty.

---

### Task 1: Establish the no-Skill baseline

**Files:**
- Read: `package.json`
- Read: `src-tauri/tauri.conf.json`
- Read: `scripts/build-sidecars.mjs`
- Do not create or modify repository files.

**Interfaces:**
- Consumes: Three fresh-agent responses produced without access to the new Skill.
- Produces: A baseline list of omitted or inconsistent behaviors that the minimal Skill must correct.

- [ ] **Step 1: Run three read-only baseline scenarios without the Skill**

Use fresh-context agents. Tell each agent not to read `docs/superpowers/specs`,
`docs/superpowers/plans`, or the not-yet-created Skill, and not to run a build.
Give them these exact prompts:

```text
场景 A：你位于 E:\github\mythpen。用户说“给我构建一个当前代码的 Windows 测试 EXE，我马上要人工验收”。工作区可能有未提交修改，不能发布。只读检查仓库后，列出你将实际执行的命令、成功标准和最终报告；不要执行命令。

场景 B：你位于 E:\github\mythpen。target/release 中有上一次留下的 EXE、MSI 和 setup.exe，用户问“测试程序完成得怎么样”。只读检查仓库后，说明你如何确保不会把失败构建后的旧文件误报为成功；不要执行命令。

场景 C：你位于 E:\github\mythpen。用户要一个可测试安装包，但 Bun 版本可能不对，并且受限沙箱可能让 Node 或 rustc 报 spawn EPERM。只读检查仓库后，说明你将怎样处理依赖、检查、权限错误和产物；不要执行命令。
```

- [ ] **Step 2: Verify RED and capture exact gaps**

For each response, score the following observable requirements:

```text
[ ] Discovers that pnpm tauri build already runs frontend and sidecar builds
[ ] Requires Bun exactly 1.3.14
[ ] Runs server tests
[ ] Calls the repository TypeScript compiler with tsconfig.app.json
[ ] Excludes pnpm lint
[ ] Does not launch, install, version-bump, tag, push, or release
[ ] Allows but reports a dirty working tree
[ ] Rejects build failure even when old artifacts exist
[ ] Selects NSIS/MSI using the current tauri.conf.json version
[ ] Reports absolute paths, size, UTC modification time, SHA-256, and cache reuse
[ ] Retries EPERM through approval rather than skipping a gate
```

Record the agents' exact omissions or rationalizations in the task transcript.
At least one inconsistent or missing item is the expected RED result. If all
three responses satisfy every item, stop and report that the proposed Skill
does not improve the observed baseline before creating it.

---

### Task 2: Initialize and implement the repository-local Skill

**Files:**
- Create: `.codex/skills/build-mythpen-test-exe/SKILL.md`
- Create: `.codex/skills/build-mythpen-test-exe/agents/openai.yaml`
- Create: `.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1`

**Interfaces:**
- Consumes: Repository root, current `src-tauri/tauri.conf.json` version, and the toolchain commands on `PATH`.
- Produces: `build-test-exe.ps1 -RepositoryRoot <path>`, exiting `0` only after all gates and artifact checks succeed.

- [ ] **Step 1: Initialize the Skill with the official scaffolder**

Run from the repository root:

```powershell
python 'C:/Users/wanghongao/.codex/skills/.system/skill-creator/scripts/init_skill.py' `
  build-mythpen-test-exe `
  --path '.codex/skills' `
  --resources scripts `
  --interface 'display_name=构建 Mythpen 测试 EXE' `
  --interface 'short_description=构建并校验可供人工验收的 Mythpen Windows 测试程序' `
  --interface 'default_prompt=使用 $build-mythpen-test-exe 构建并校验当前 Mythpen Windows 测试程序。'
```

Expected: the three paths listed above exist and no example/placeholder
resource file is created.

- [ ] **Step 2: Replace the generated SKILL.md with the minimal baseline-driven workflow**

Write exactly this initial content, then add only constraints justified by the
RED observations from Task 1:

```markdown
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
```

- [ ] **Step 3: Implement the deterministic PowerShell build script**

Create `.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1`
with this complete implementation:

```powershell
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter()]
  [string]$RepositoryRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$requiredBunVersion = '1.3.14'
$stage = 'initialize'

function Resolve-Executable {
  param([Parameter(Mandatory = $true)][string]$Name)

  $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $command) {
    throw "Required executable '$Name' is unavailable on PATH."
  }
  return $command.Source
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter()][string[]]$Arguments = @()
  )

  $output = & $FilePath @Arguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = (($output | ForEach-Object { $_.ToString() }) -join "`n").Trim()
  if ($exitCode -ne 0) {
    throw "'$FilePath $($Arguments -join ' ')' failed with exit code $exitCode. $text".Trim()
  }
  return $text
}

function Invoke-BuildStep {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter()][string[]]$Arguments = @()
  )

  Write-Host "[step] $Label"
  & $FilePath @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    throw "$Label failed with exit code $exitCode."
  }
}

function Get-ArtifactFingerprint {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  $file = Get-Item -LiteralPath $Path
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  return "$($file.Length):$($file.LastWriteTimeUtc.Ticks):$hash"
}

function Resolve-SingleArtifact {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Filter
  )

  $candidates = @()
  if (Test-Path -LiteralPath $Directory -PathType Container) {
    $candidates = @(Get-ChildItem -LiteralPath $Directory -File -Filter $Filter)
  }
  if ($candidates.Count -ne 1) {
    $names = ($candidates | ForEach-Object { $_.FullName }) -join ', '
    throw "Expected exactly one current-version $Kind artifact matching '$Filter' in '$Directory'; found $($candidates.Count). $names".Trim()
  }
  return $candidates[0]
}

function Write-ArtifactRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Kind,
    [Parameter(Mandatory = $true)][System.IO.FileInfo]$File,
    [Parameter(Mandatory = $true)][hashtable]$BeforeFingerprints
  )

  if ($File.Length -le 0) {
    throw "$Kind artifact is empty: $($File.FullName)"
  }

  $hash = (Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $fingerprint = "$($File.Length):$($File.LastWriteTimeUtc.Ticks):$hash"
  $state = 'written'
  if ($BeforeFingerprints.ContainsKey($File.FullName) -and
      $BeforeFingerprints[$File.FullName] -eq $fingerprint) {
    $state = 'reused'
  }

  Write-Host "[artifact] kind=$Kind"
  Write-Host "  path=$($File.FullName)"
  Write-Host "  size_bytes=$($File.Length)"
  Write-Host "  modified_utc=$($File.LastWriteTimeUtc.ToString('o'))"
  Write-Host "  sha256=$hash"
  Write-Host "  state=$state"
}

try {
  if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = [System.IO.Path]::GetFullPath(
      (Join-Path $PSScriptRoot '../../../..')
    )
  }
  $RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path

  $requiredFiles = @(
    'package.json',
    'src-tauri/tauri.conf.json',
    'scripts/build-sidecars.mjs'
  )
  foreach ($relativePath in $requiredFiles) {
    $candidate = Join-Path $RepositoryRoot $relativePath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      throw "Not a Mythpen repository root; missing '$relativePath' under '$RepositoryRoot'."
    }
  }

  Push-Location $RepositoryRoot
  try {
    $stage = 'toolchain'
    $git = Resolve-Executable -Name 'git'
    $node = Resolve-Executable -Name 'node'
    $pnpm = Resolve-Executable -Name 'pnpm'
    $bun = Resolve-Executable -Name 'bun'
    $rustc = Resolve-Executable -Name 'rustc'
    $cargo = Resolve-Executable -Name 'cargo'

    $nodeVersion = Invoke-Captured -FilePath $node -Arguments @('--version')
    $pnpmVersion = Invoke-Captured -FilePath $pnpm -Arguments @('--version')
    $bunVersion = Invoke-Captured -FilePath $bun -Arguments @('--version')
    $rustcVersion = Invoke-Captured -FilePath $rustc -Arguments @('--version')
    $cargoVersion = Invoke-Captured -FilePath $cargo -Arguments @('--version')
    if ($bunVersion -ne $requiredBunVersion) {
      throw "Bun $requiredBunVersion is required; found '$bunVersion'."
    }

    Write-Host "[tool] node=$nodeVersion"
    Write-Host "[tool] pnpm=$pnpmVersion"
    Write-Host "[tool] bun=$bunVersion"
    Write-Host "[tool] rustc=$rustcVersion"
    Write-Host "[tool] cargo=$cargoVersion"

    $stage = 'source-state'
    $commit = Invoke-Captured -FilePath $git -Arguments @('rev-parse', '--short=12', 'HEAD')
    $branch = Invoke-Captured -FilePath $git -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
    $porcelain = Invoke-Captured -FilePath $git -Arguments @('status', '--porcelain')
    $worktree = if ([string]::IsNullOrWhiteSpace($porcelain)) { 'clean' } else { 'dirty' }
    Write-Host "[source] branch=$branch commit=$commit worktree=$worktree"

    $stage = 'dependencies'
    $tscPath = Join-Path $RepositoryRoot 'node_modules/typescript/bin/tsc'
    $tauriPackage = Join-Path $RepositoryRoot 'node_modules/@tauri-apps/cli/package.json'
    if (-not (Test-Path -LiteralPath $tscPath -PathType Leaf) -or
        -not (Test-Path -LiteralPath $tauriPackage -PathType Leaf)) {
      Invoke-BuildStep -Label 'Install frozen dependencies' -FilePath $pnpm -Arguments @(
        'install',
        '--frozen-lockfile'
      )
    }
    if (-not (Test-Path -LiteralPath $tscPath -PathType Leaf)) {
      throw "Local TypeScript compiler is missing after dependency installation: $tscPath"
    }

    $tauriConfigPath = Join-Path $RepositoryRoot 'src-tauri/tauri.conf.json'
    $tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 |
      ConvertFrom-Json
    $version = [string]$tauriConfig.version
    if ([string]::IsNullOrWhiteSpace($version)) {
      throw "src-tauri/tauri.conf.json does not contain a version."
    }

    $releaseDirectory = Join-Path $RepositoryRoot 'src-tauri/target/release'
    $desktopPath = Join-Path $releaseDirectory 'mythpen.exe'
    $nsisDirectory = Join-Path $releaseDirectory 'bundle/nsis'
    $msiDirectory = Join-Path $releaseDirectory 'bundle/msi'
    $nsisFilter = "*_${version}_*-setup.exe"
    $msiFilter = "*_${version}_*.msi"

    $beforeFingerprints = @{}
    $beforeCandidates = @($desktopPath)
    if (Test-Path -LiteralPath $nsisDirectory -PathType Container) {
      $beforeCandidates += @(
        Get-ChildItem -LiteralPath $nsisDirectory -File -Filter $nsisFilter |
          ForEach-Object { $_.FullName }
      )
    }
    if (Test-Path -LiteralPath $msiDirectory -PathType Container) {
      $beforeCandidates += @(
        Get-ChildItem -LiteralPath $msiDirectory -File -Filter $msiFilter |
          ForEach-Object { $_.FullName }
      )
    }
    foreach ($path in $beforeCandidates) {
      $fingerprint = Get-ArtifactFingerprint -Path $path
      if ($null -ne $fingerprint) {
        $beforeFingerprints[$path] = $fingerprint
      }
    }

    $stage = 'server-tests'
    Invoke-BuildStep -Label 'Server tests' -FilePath $pnpm -Arguments @('test:server')

    $stage = 'typecheck'
    Invoke-BuildStep -Label 'TypeScript app check' -FilePath $node -Arguments @(
      $tscPath,
      '--project',
      'tsconfig.app.json',
      '--noEmit'
    )

    $stage = 'tauri-build'
    Invoke-BuildStep -Label 'Tauri Windows build' -FilePath $pnpm -Arguments @(
      'tauri',
      'build'
    )

    $stage = 'artifacts'
    if (-not (Test-Path -LiteralPath $desktopPath -PathType Leaf)) {
      throw "Desktop artifact is missing: $desktopPath"
    }
    $desktop = Get-Item -LiteralPath $desktopPath
    $nsis = Resolve-SingleArtifact -Kind 'NSIS' -Directory $nsisDirectory -Filter $nsisFilter
    $msi = Resolve-SingleArtifact -Kind 'MSI' -Directory $msiDirectory -Filter $msiFilter

    Write-ArtifactRecord -Kind 'desktop' -File $desktop -BeforeFingerprints $beforeFingerprints
    Write-ArtifactRecord -Kind 'nsis' -File $nsis -BeforeFingerprints $beforeFingerprints
    Write-ArtifactRecord -Kind 'msi' -File $msi -BeforeFingerprints $beforeFingerprints

    Write-Host '[result] success'
    Write-Host '[result] artifacts were not launched or installed'
  }
  finally {
    Pop-Location
  }
}
catch {
  [Console]::Error.WriteLine("[result] failure stage=$stage")
  [Console]::Error.WriteLine("[error] $($_.Exception.Message)")
  exit 1
}
```

- [ ] **Step 4: Verify the generated UI metadata**

`agents/openai.yaml` must contain only:

```yaml
interface:
  display_name: "构建 Mythpen 测试 EXE"
  short_description: "构建并校验可供人工验收的 Mythpen Windows 测试程序"
  default_prompt: "使用 $build-mythpen-test-exe 构建并校验当前 Mythpen Windows 测试程序。"
```

If scaffolding output differs, regenerate it with
`generate_openai_yaml.py` and the same three `--interface` values; do not add
icons, colors, MCP dependencies, or invocation policy.

---

### Task 3: Validate the Skill and perform a real Windows build

**Files:**
- Validate: `.codex/skills/build-mythpen-test-exe/SKILL.md`
- Validate: `.codex/skills/build-mythpen-test-exe/agents/openai.yaml`
- Execute: `.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1`
- Build outputs: `src-tauri/target/release/` (Git-ignored)

**Interfaces:**
- Consumes: `build-test-exe.ps1 -RepositoryRoot E:/github/mythpen`.
- Produces: A zero exit code and exactly three verified artifact records.

- [ ] **Step 1: Run the official Skill validator**

```powershell
python 'C:/Users/wanghongao/.codex/skills/.system/skill-creator/scripts/quick_validate.py' `
  '.codex/skills/build-mythpen-test-exe'
```

Expected:

```text
Skill is valid!
```

- [ ] **Step 2: Parse the PowerShell script without executing it**

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Resolve-Path '.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1'),
  [ref]$tokens,
  [ref]$errors
) | Out-Null
if ($errors.Count -ne 0) { $errors | Format-List; exit 1 }
```

Expected: exit code `0` with no parser errors.

- [ ] **Step 3: Run the complete build script**

```powershell
& '.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1' `
  -RepositoryRoot (Get-Location).Path
```

Expected:

```text
[step] Server tests
[step] TypeScript app check
[step] Tauri Windows build
[artifact] kind=desktop
[artifact] kind=nsis
[artifact] kind=msi
[result] success
[result] artifacts were not launched or installed
```

If the environment returns `spawn EPERM`, `spawnSync rustc EPERM`, or another
sandbox denial, rerun the exact script with the execution tool's
`require_escalated` permission. Do not accept a partial run.

- [ ] **Step 4: Independently verify the reported artifacts**

Read `src-tauri/tauri.conf.json` for the version, then confirm:

```powershell
$version = (Get-Content -Raw -Encoding UTF8 'src-tauri/tauri.conf.json' |
  ConvertFrom-Json).version
$files = @(
  Get-Item 'src-tauri/target/release/mythpen.exe'
  Get-ChildItem 'src-tauri/target/release/bundle/nsis' -File -Filter "*_${version}_*-setup.exe"
  Get-ChildItem 'src-tauri/target/release/bundle/msi' -File -Filter "*_${version}_*.msi"
)
if ($files.Count -ne 3 -or @($files | Where-Object Length -le 0).Count -ne 0) {
  throw 'Expected exactly three non-empty current-version test artifacts.'
}
$files | Get-FileHash -Algorithm SHA256
```

Expected: exactly three SHA-256 rows and no error.

- [ ] **Step 5: Verify repository scope**

```powershell
git diff --check
git status --short
```

Expected: only the plan and the three Skill files are changed; Tauri targets,
sidecar binaries, dependency folders, and WASM copies remain ignored.

- [ ] **Step 6: Commit the verified implementation**

```powershell
git add `
  .codex/skills/build-mythpen-test-exe/SKILL.md `
  .codex/skills/build-mythpen-test-exe/agents/openai.yaml `
  .codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1
git commit -m "feat: add test exe build skill"
```

Expected: one commit containing only the three Skill implementation files.
The reviewed implementation plan is already committed before the isolated
worktree is created.

---

### Task 4: Forward-test discovery and reporting

**Files:**
- Read: `.codex/skills/build-mythpen-test-exe/SKILL.md`
- Read/execute: `.codex/skills/build-mythpen-test-exe/scripts/build-test-exe.ps1`
- Modify only if a forward test exposes a concrete gap.

**Interfaces:**
- Consumes: The committed Skill and the three baseline scenarios from Task 1.
- Produces: Fresh-agent evidence that the Skill is discoverable, invokes the script, respects boundaries, and reports the verified artifacts.

- [ ] **Step 1: Run one real fresh-agent forward test**

Use a fresh-context agent with this exact prompt:

```text
Use $build-mythpen-test-exe at E:/github/mythpen/.codex/skills/build-mythpen-test-exe to handle this request in E:/github/mythpen:

“测试程序完成得怎么样？请现在构建一个我能测试的 Windows 程序。”
```

Expected: the agent reads the Skill, invokes its PowerShell script, waits for
completion, and returns the source state plus all three artifact records. It
does not launch, install, version-bump, commit, tag, push, release, or run lint.

- [ ] **Step 2: Run two read-only variation checks**

Use fresh-context agents with these prompts:

```text
Use $build-mythpen-test-exe at E:/github/mythpen/.codex/skills/build-mythpen-test-exe. Read-only evaluation: explain how you would handle “旧安装包还在，但刚才构建失败了，测试版是不是也算完成？”. Do not run the build.
```

```text
Use $build-mythpen-test-exe at E:/github/mythpen/.codex/skills/build-mythpen-test-exe. Read-only evaluation: explain how you would handle a build whose tests fail with spawn EPERM. Do not run the build.
```

Expected: the first refuses to report success from old files; the second
requests an approved retry of the same script and never skips a gate.

- [ ] **Step 3: Refactor only observed gaps and stay GREEN**

If a forward test violates the rubric, capture its exact wording, update the
smallest relevant section of `SKILL.md`, and rerun:

```powershell
python 'C:/Users/wanghongao/.codex/skills/.system/skill-creator/scripts/quick_validate.py' `
  '.codex/skills/build-mythpen-test-exe'
git diff --check
```

Then repeat only the failed forward-test prompt. Do not add hypothetical rules
that were not exposed by the baseline or forward tests.

- [ ] **Step 4: Commit a forward-test correction only if needed**

```powershell
git add .codex/skills/build-mythpen-test-exe/SKILL.md
git commit -m "fix: tighten test exe build skill"
```

Expected: no second commit when all forward tests pass unchanged; otherwise a
small commit containing only the evidence-driven Skill wording correction.
