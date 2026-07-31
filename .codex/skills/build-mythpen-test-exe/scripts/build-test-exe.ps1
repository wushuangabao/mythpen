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

  $originalErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $output = & $FilePath @Arguments 2>&1
    $exitCode = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $originalErrorActionPreference
  }
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
