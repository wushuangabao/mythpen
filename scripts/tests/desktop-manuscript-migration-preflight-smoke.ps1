[CmdletBinding()]
param(
  [ValidateSet('Run', 'SelfTest')]
  [string]$Mode = 'Run',
  [string]$DesktopPath,
  [string]$SidecarPath,
  [string]$ResultPath,
  [int]$TimeoutSeconds = 180,
  [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $DesktopPath) { $DesktopPath = Join-Path $scriptRoot '..\..\src-tauri\target\debug\mythpen.exe' }
if (-not $SidecarPath) { $SidecarPath = Join-Path $scriptRoot '..\..\src-tauri\binaries\mythpen-server-x86_64-pc-windows-msvc.exe' }
if (-not $ResultPath) { $ResultPath = Join-Path ([System.IO.Path]::GetTempPath()) ("mythpen-manuscript-migration-preflight-smoke-{0}.json" -f [guid]::NewGuid().ToString('N')) }

$script:ResultType = 'mythpen.desktop-l2-migration-preflight-smoke.v1'
$script:BootstrapMarker = 'mythpen.desktop-l2-migration-preflight-smoke-bootstrap.v1'
$script:ExpectedCases = @(
  'unresolved_body',
  'unresolved_sidecar',
  'unresolved_volume_metadata',
  'unresolved_structure',
  'unloaded_queue',
  'stale_multi_window_epoch',
  'non_responsive_window',
  'all_persisted_or_explicitly_resolved'
)

function Write-NotRun([string]$Reason) {
  Write-Output ("NOT_RUN desktop-manuscript-migration-preflight-smoke: {0}" -f $Reason)
}

function Assert-AbsoluteExistingFile([string]$Value, [string]$Label) {
  if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') { throw "$Label must be absolute." }
  $resolved = [System.IO.Path]::GetFullPath($Value)
  $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must identify one ordinary non-reparse file."
  }
  return $resolved
}

function Assert-CreateNewResultPath([string]$Value) {
  if ($Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])') { throw 'ResultPath must be absolute.' }
  $resolved = [System.IO.Path]::GetFullPath($Value)
  if (Test-Path -LiteralPath $resolved) { throw 'ResultPath must be create-new.' }
  if (-not (Test-Path -LiteralPath (Split-Path -Parent $resolved) -PathType Container)) {
    throw 'ResultPath parent must already exist.'
  }
  return $resolved
}

function Test-BinaryMarker([string]$Path, [string]$Marker) {
  return [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($Path)).Contains($Marker)
}

function New-NonceHex {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Get-Sha256Hex([string]$Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') })
  } finally { $sha.Dispose() }
}

function Get-FileSha256Hex([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ExactProperties($Value, [string[]]$Expected, [string]$Label) {
  if ($null -eq $Value) { throw "$Label must be an object." }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expectedSorted = @($Expected | Sort-Object)
  if (($actual -join "`n") -ne ($expectedSorted -join "`n")) {
    throw "$Label has an invalid property set."
  }
}

function Assert-ArtifactIdentity($Value, [string]$ExpectedPath, [string]$Label) {
  Assert-ExactProperties $Value @('path', 'bytes', 'sha256') $Label
  $resolvedExpected = [System.IO.Path]::GetFullPath($ExpectedPath)
  if ([System.IO.Path]::GetFullPath([string]$Value.path) -ne $resolvedExpected) {
    throw "$Label path is not bound to the launched artifact."
  }
  $item = Get-Item -LiteralPath $resolvedExpected -Force -ErrorAction Stop
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw "$Label must remain an ordinary file."
  }
  if ([int64]$Value.bytes -ne [int64]$item.Length -or [string]$Value.sha256 -ne (Get-FileSha256Hex $resolvedExpected)) {
    throw "$Label bytes/hash binding is invalid."
  }
}

function Write-CreateNewUtf8([string]$Path, [string]$Text) {
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try {
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($Text)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
}

function Assert-Result(
  [string]$Path,
  [string]$RunId,
  [string]$RequestPath,
  [string]$DesktopExecutable,
  [string]$SidecarExecutable
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'Debug desktop did not create the result.' }
  $result = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
  Assert-ExactProperties $result @(
    'version', 'type', 'status', 'sourceCommit', 'targetTriple', 'desktop', 'sidecar',
    'auth', 'runId', 'request', 'suite', 'cases'
  ) 'result'
  if ($result.version -ne 1 -or $result.type -ne $script:ResultType -or $result.status -ne 'PASS') {
    throw 'Migration preflight result identity/status is invalid.'
  }
  if ([string]$result.sourceCommit -notmatch '^[0-9a-f]{40}$' -or $result.targetTriple -ne 'x86_64-pc-windows-msvc') {
    throw 'Migration preflight source/target binding is invalid.'
  }
  Assert-ArtifactIdentity $result.desktop $DesktopExecutable 'desktop'
  Assert-ArtifactIdentity $result.sidecar $SidecarExecutable 'sidecar'
  Assert-ExactProperties $result.auth @('mode') 'auth'
  if ($result.runId -ne $RunId -or $result.auth.mode -ne 'debug-only-one-time-nonce-v1') {
    throw 'Migration preflight result is not bound to this authenticated run.'
  }
  Assert-ArtifactIdentity $result.request $RequestPath 'request'
  Assert-ExactProperties $result.suite @('total', 'passed', 'failed') 'suite'
  if ($result.suite.total -ne 8 -or $result.suite.passed -ne 8 -or $result.suite.failed -ne 0) {
    throw 'Migration preflight fixed matrix is incomplete.'
  }
  $actualIds = @($result.cases | ForEach-Object { $_.id })
  if (($actualIds -join "`n") -ne ($script:ExpectedCases -join "`n")) {
    throw 'Migration preflight returned a caller-defined or reordered matrix.'
  }
  foreach ($case in $result.cases) {
    Assert-ExactProperties $case @('id', 'status', 'apiCalls', 'serviceCalls', 'beforeDigest', 'afterDigest') "case $($case.id)"
    if ($case.status -ne 'PASS') { throw "Failed migration-preflight case: $($case.id)" }
    if ([string]$case.beforeDigest -notmatch '^[0-9a-f]{64}$' -or [string]$case.afterDigest -notmatch '^[0-9a-f]{64}$') {
      throw "Case returned an invalid durable digest: $($case.id)"
    }
    if ($case.id -eq 'all_persisted_or_explicitly_resolved') {
      if ($case.apiCalls -ne 1 -or $case.serviceCalls -ne 1 -or $case.beforeDigest -eq $case.afterDigest) {
        throw 'Positive case did not call API/service exactly once and mutate durable state.'
      }
    } elseif ($case.apiCalls -ne 0 -or $case.serviceCalls -ne 0) {
      throw "Negative case crossed admission: $($case.id)"
    }
    if ($case.beforeDigest -ne $case.afterDigest -and $case.id -ne 'all_persisted_or_explicitly_resolved') {
      throw "Negative case mutated durable state: $($case.id)"
    }
  }
}

function Remove-VerifiedRunRoot([string]$Path, [string]$ExpectedParent, [string]$RunId) {
  $resolved = [System.IO.Path]::GetFullPath($Path)
  $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $resolved))
  $leaf = Split-Path -Leaf $resolved
  if ($parent -ne [System.IO.Path]::GetFullPath($ExpectedParent) -or $leaf -ne ".mythpen-preflight-smoke-$RunId") {
    throw 'Refusing to clean a path outside the exact migration-preflight-smoke namespace.'
  }
  $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'Refusing to recursively clean a non-directory or reparse target.'
  }
  for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    try {
      Remove-Item -LiteralPath $resolved -Recurse -Force
      return
    } catch {
      if ($attempt -eq 19) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

if ($Mode -eq 'SelfTest') {
  if ($script:ExpectedCases.Count -ne 8) { throw 'Migration-preflight fixed matrix is incomplete.' }
  if ($script:ResultType -eq $script:BootstrapMarker) { throw 'Result and bootstrap identities must differ.' }
  Write-Output 'PASS desktop-manuscript-migration-preflight-smoke SelfTest (harness only; compiled product NOT_RUN)'
  exit 0
}

$requestPath = $null
$claimPath = $null
$rawPath = $null
$runRoot = $null
$runId = $null
$completed = $false
try {
  try {
    $DesktopPath = Assert-AbsoluteExistingFile $DesktopPath 'DesktopPath'
    $SidecarPath = Assert-AbsoluteExistingFile $SidecarPath 'SidecarPath'
    $ResultPath = Assert-CreateNewResultPath $ResultPath
  } catch {
    Write-NotRun $_.Exception.Message
    exit 2
  }
  if (-not (Test-BinaryMarker $DesktopPath $script:BootstrapMarker)) {
    Write-NotRun 'debug desktop does not contain the authenticated migration-preflight bootstrap'
    exit 2
  }

  $runId = [guid]::NewGuid().ToString('D').ToLowerInvariant()
  $nonce = New-NonceHex
  $base = [System.IO.Path]::GetFileNameWithoutExtension($ResultPath)
  $requestPath = Join-Path (Split-Path -Parent $ResultPath) (".{0}.{1}.request.json" -f $base, $runId)
  $claimPath = "$requestPath.claimed"
  $rawPath = "$ResultPath.raw.log"
  if (Test-Path -LiteralPath $rawPath) { throw 'Derived raw output path already exists.' }
  if (Test-Path -LiteralPath $claimPath) { throw 'Derived one-shot claim path already exists.' }
  if (Test-Path -LiteralPath $requestPath) { throw 'Derived request path already exists.' }
  $runRoot = Join-Path (Split-Path -Parent $ResultPath) (".mythpen-preflight-smoke-{0}" -f $runId)
  [System.IO.Directory]::CreateDirectory($runRoot) | Out-Null
  $profileRoot = Join-Path $runRoot 'profile'
  $appDataRoot = Join-Path $profileRoot 'AppData\Roaming'
  $localAppDataRoot = Join-Path $profileRoot 'AppData\Local'
  $xdgConfigRoot = Join-Path $profileRoot '.config'
  $xdgDataRoot = Join-Path $profileRoot '.local\share'
  foreach ($directory in @($profileRoot, $appDataRoot, $localAppDataRoot, $xdgConfigRoot, $xdgDataRoot)) {
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  $request = [ordered]@{
    version = 1
    type = 'mythpen.desktop-l2-migration-preflight-smoke-request.v1'
    runId = $runId
    nonceSha256 = Get-Sha256Hex $nonce
    resultPath = $ResultPath
    sidecarPath = $SidecarPath
  } | ConvertTo-Json -Compress
  Write-CreateNewUtf8 $requestPath $request

  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $DesktopPath
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Arguments = '"' + $requestPath.Replace('"', '\"') + '"'
  $start.EnvironmentVariables['MYTHPEN_DESKTOP_MIGRATION_PREFLIGHT_SMOKE_NONCE'] = $nonce
  $start.EnvironmentVariables['MYTHPEN_DATA_DIR'] = $runRoot
  $start.EnvironmentVariables['APPDATA'] = $appDataRoot
  $start.EnvironmentVariables['LOCALAPPDATA'] = $localAppDataRoot
  $start.EnvironmentVariables['XDG_CONFIG_HOME'] = $xdgConfigRoot
  $start.EnvironmentVariables['XDG_DATA_HOME'] = $xdgDataRoot
  $process = [System.Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    $process.WaitForExit()
    Write-CreateNewUtf8 $rawPath ("STDOUT`n{0}`nSTDERR`n{1}" -f $stdout.Result, $stderr.Result)
    throw 'Debug desktop migration-preflight smoke timed out.'
  }
  $process.WaitForExit()
  Write-CreateNewUtf8 $rawPath ("STDOUT`n{0}`nSTDERR`n{1}" -f $stdout.Result, $stderr.Result)
  if ($process.ExitCode -ne 0) { throw "Debug desktop migration-preflight smoke exited $($process.ExitCode)." }
  Assert-Result $ResultPath $runId $requestPath $DesktopPath $SidecarPath
  $completed = $true
  Write-Output "PASS desktop-manuscript-migration-preflight-smoke result=$ResultPath"
} catch {
  Write-Error $_
  exit 1
} finally {
  if ($completed -and -not $KeepArtifacts -and $runRoot -and (Test-Path -LiteralPath $runRoot)) {
    Remove-VerifiedRunRoot $runRoot (Split-Path -Parent $ResultPath) $runId
  }
  if ($completed -and -not $KeepArtifacts -and $requestPath -and (Test-Path -LiteralPath $requestPath)) {
    Remove-Item -LiteralPath $requestPath -Force
  }
  if ($completed -and -not $KeepArtifacts -and $claimPath -and (Test-Path -LiteralPath $claimPath)) {
    Remove-Item -LiteralPath $claimPath -Force
  }
  if ($completed -and -not $KeepArtifacts -and $rawPath -and (Test-Path -LiteralPath $rawPath)) {
    Remove-Item -LiteralPath $rawPath -Force
  }
}
