[CmdletBinding()]
param(
  [ValidateSet('All', 'Sidecar', 'Desktop', 'SelfTest')]
  [string]$Mode = 'All',
  [string]$SidecarPath,
  [string]$DesktopPath,
  [int]$TimeoutSeconds = 30,
  [switch]$KeepArtifacts
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Results = [System.Collections.Generic.List[object]]::new()
$script:Processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:DrainTasks = [System.Collections.Generic.List[object]]::new()
$script:SmokeRoots = [System.Collections.Generic.List[string]]::new()
$script:FakePortListener = $null

Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Specialized;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

public sealed class MythpenSmokeDesktopCdpUnavailableException : Exception
{
    public MythpenSmokeDesktopCdpUnavailableException(string message) : base(message) { }
}

public static class MythpenSmokeProcessEnvironment
{
    private static StringDictionary GetOrCreate(ProcessStartInfo startInfo)
    {
        var field = typeof(ProcessStartInfo).GetField(
            "environmentVariables",
            BindingFlags.Instance | BindingFlags.NonPublic
        );
        if (field == null || field.FieldType != typeof(StringDictionary))
        {
            return startInfo.EnvironmentVariables;
        }

        var environment = (StringDictionary)field.GetValue(startInfo);
        if (environment != null) return environment;

        environment = new StringDictionary();
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
        {
            environment[Convert.ToString(entry.Key)] = Convert.ToString(entry.Value);
        }
        field.SetValue(startInfo, environment);
        return environment;
    }

    public static void Set(ProcessStartInfo startInfo, IDictionary values)
    {
        if (startInfo == null) throw new ArgumentNullException("startInfo");
        if (values == null) throw new ArgumentNullException("values");
        var environment = GetOrCreate(startInfo);
        foreach (DictionaryEntry entry in values)
        {
            environment[Convert.ToString(entry.Key)] = Convert.ToString(entry.Value);
        }
    }

    public static string Get(ProcessStartInfo startInfo, string key)
    {
        return GetOrCreate(startInfo)[key];
    }
}

public static class MythpenSmokeWindow
{
    private const int SwHide = 0;
    private const int SwMinimize = 6;
    private const uint WmClose = 0x0010;
    private const uint WmNull = 0x0000;
    private const uint SmtoBlock = 0x0001;
    private const uint SmtoAbortIfHung = 0x0002;

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder className, int maximumCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr window, StringBuilder title, int maximumCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessageTimeoutW(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        uint flags,
        uint timeoutMilliseconds,
        out IntPtr result
    );

    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    private static string ReadClassName(IntPtr window)
    {
        var value = new StringBuilder(256);
        return GetClassNameW(window, value, value.Capacity) > 0 ? value.ToString() : String.Empty;
    }

    private static string ReadTitle(IntPtr window)
    {
        var value = new StringBuilder(512);
        return GetWindowTextW(window, value, value.Capacity) > 0 ? value.ToString() : String.Empty;
    }

    public static bool MatchesTauriMainWindowIdentity(string className, string title, bool visible)
    {
        return visible
            && String.Equals(className, "Tauri Window", StringComparison.Ordinal)
            && String.Equals(title, "Mythpen", StringComparison.Ordinal);
    }

    public static bool IsTauriMainWindowForProcess(IntPtr window, int processId)
    {
        if (window == IntPtr.Zero || processId <= 0 || !IsWindow(window)) return false;
        uint ownerProcessId;
        GetWindowThreadProcessId(window, out ownerProcessId);
        return ownerProcessId == (uint)processId
            && MatchesTauriMainWindowIdentity(ReadClassName(window), ReadTitle(window), IsWindowVisible(window));
    }

    public static IntPtr[] FindTauriMainWindows(int processId)
    {
        if (processId <= 0) throw new ArgumentOutOfRangeException("processId");
        var matches = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            if (IsTauriMainWindowForProcess(window, processId)) matches.Add(window);
            return true;
        }, IntPtr.Zero);
        return matches.ToArray();
    }

    public static bool IsResponsive(IntPtr window)
    {
        if (window == IntPtr.Zero || !IsWindow(window) || !IsWindowVisible(window)) return false;
        IntPtr result;
        return SendMessageTimeoutW(
            window,
            WmNull,
            IntPtr.Zero,
            IntPtr.Zero,
            SmtoBlock | SmtoAbortIfHung,
            250,
            out result
        ) != IntPtr.Zero;
    }

    public static void Minimize(IntPtr window)
    {
        if (window == IntPtr.Zero) throw new ArgumentException("Window handle is required.", "window");
        ShowWindowAsync(window, SwMinimize);
    }

    public static void Hide(IntPtr window)
    {
        if (window == IntPtr.Zero) throw new ArgumentException("Window handle is required.", "window");
        ShowWindowAsync(window, SwHide);
    }

    public static void Close(IntPtr window)
    {
        if (window == IntPtr.Zero) throw new ArgumentException("Window handle is required.", "window");
        if (!PostMessageW(window, WmClose, IntPtr.Zero, IntPtr.Zero)) {
            throw new InvalidOperationException("Unable to post WM_CLOSE to the Tauri application window.");
        }
    }
}
'@

function Add-SmokeResult {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet('PASS', 'FAIL', 'NOT_RUN', 'DEFERRED')][string]$Status,
    [Parameter(Mandatory = $true)][string]$Evidence
  )
  $script:Results.Add([ordered]@{ name = $Name; status = $Status; evidence = $Evidence })
}

function Add-DesktopNotRunResults {
  param([Parameter(Mandatory = $true)][string]$Reason)
  foreach ($name in @('second_instance', 'desktop_session', 'desktop_normal_shutdown', 'emergency_exit', 'sentinel_unowned_survived', 'recovery_notice_e2e')) {
    Add-SmokeResult $name 'NOT_RUN' $Reason
  }
}

function Get-RemoteDebuggingPolicyEvidence {
  $candidates = @(
    [ordered]@{ Label = 'HKCU Edge'; Path = 'HKCU:\Software\Policies\Microsoft\Edge' },
    [ordered]@{ Label = 'HKCU Edge/WebView2'; Path = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2' },
    [ordered]@{ Label = 'HKLM Edge'; Path = 'HKLM:\Software\Policies\Microsoft\Edge' },
    [ordered]@{ Label = 'HKLM Edge/WebView2'; Path = 'HKLM:\Software\Policies\Microsoft\Edge\WebView2' }
  )
  $evidence = foreach ($candidate in $candidates) {
    try {
      if (-not (Test-Path -LiteralPath $candidate.Path)) {
        "$($candidate.Label)=key_absent"
        continue
      }
      $item = Get-ItemProperty -LiteralPath $candidate.Path
      $property = $item.PSObject.Properties['RemoteDebuggingAllowed']
      if (-not $property) {
        "$($candidate.Label)=value_absent"
      } else {
        "$($candidate.Label)=$([string]$property.Value)"
      }
    } catch {
      "$($candidate.Label)=read_error"
    }
  }
  return ($evidence -join '; ')
}

function New-RandomHex {
  param([int]$ByteCount = 32)
  $bytes = New-Object byte[] $ByteCount
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function New-ControlledCdpPortLease {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Server.ExclusiveAddressUse = $true
  $listener.Start()
  $port = [int]([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
  if ($port -lt 1 -or $port -gt 65535) {
    $listener.Stop()
    throw 'Unable to reserve a safe positive loopback port for desktop CDP.'
  }
  return [ordered]@{ Listener = $listener; Port = $port }
}

function Get-NonceDigest {
  param([Parameter(Mandatory = $true)][string]$Nonce)
  if ($Nonce -notmatch '^[0-9a-fA-F]{64}$') { throw 'Smoke nonce must contain exactly 32 bytes of hexadecimal data.' }
  $bytes = New-Object byte[] ($Nonce.Length / 2)
  for ($index = 0; $index -lt $bytes.Length; $index += 1) {
    $bytes[$index] = [Convert]::ToByte($Nonce.Substring($index * 2, 2), 16)
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function New-SmokeEnvironment {
  param([string]$Label)
  $root = Join-Path ([System.IO.Path]::GetTempPath()) ("mythpen-desktop-smoke-{0}-{1}" -f $Label, [guid]::NewGuid().ToString('N'))
  $profile = Join-Path $root 'profile'
  $data = Join-Path $root 'data'
  $exports = Join-Path $root 'exports'
  $webview2 = Join-Path $root 'webview2'
  foreach ($directory in @($root, $profile, $data, $exports, $webview2)) {
    [System.IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  $script:SmokeRoots.Add($root)
  return [ordered]@{
    Root = $root
    Profile = $profile
    Data = $data
    Exports = $exports
    WebView2 = $webview2
    Environment = [ordered]@{
      APPDATA = (Join-Path $profile 'AppData\Roaming')
      HOME = $profile
      LOCALAPPDATA = (Join-Path $profile 'AppData\Local')
      MYTHPEN_DATA_DIR = $data
      MYTHPEN_EXPORT_DIR = $exports
      USERPROFILE = $profile
      WEBVIEW2_USER_DATA_FOLDER = $webview2
      XDG_CONFIG_HOME = (Join-Path $profile '.config')
      XDG_DATA_HOME = (Join-Path $profile '.local\share')
    }
  }
}

function Assert-SmokeRootSafeForCleanup {
  param([Parameter(Mandatory = $true)][string]$Root)
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
  $parent = [System.IO.Path]::GetDirectoryName($resolvedRoot).TrimEnd('\', '/')
  $leaf = [System.IO.Path]::GetFileName($resolvedRoot)
  if (
    -not $parent.Equals($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $leaf.StartsWith('mythpen-desktop-smoke-', [System.StringComparison]::Ordinal)
  ) {
    throw 'Refusing to clean a path outside the exact desktop smoke temp namespace.'
  }
  return $resolvedRoot
}

function Get-TreeDigest {
  param([string[]]$Paths)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $records = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in $Paths) {
      if (-not (Test-Path -LiteralPath $candidate)) {
        $records.Add('ABSENT')
        continue
      }
      $item = Get-Item -LiteralPath $candidate -Force
      $identityOutput = & fsutil.exe file queryfileid $item.FullName 2>&1
      if ($LASTEXITCODE -ne 0 -or -not $identityOutput) {
        throw 'Unable to capture the file identity of a default user-state root.'
      }
      $rootIdentity = (($identityOutput | ForEach-Object { [string]$_ }) -join ' ').Trim()
      if (-not $item.PSIsContainer) {
        $records.Add("FILE:${rootIdentity}:$($item.Length):$((Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash)")
        continue
      }
      $records.Add("DIRECTORY:$rootIdentity")
      foreach ($entry in Get-ChildItem -LiteralPath $item.FullName -Force -Recurse | Sort-Object FullName) {
        $relative = $entry.FullName.Substring($item.FullName.Length).TrimStart('\', '/')
        if ($entry.PSIsContainer) {
          $records.Add("D:$relative")
        } else {
          $records.Add("F:${relative}:$($entry.Length):$((Get-FileHash -Algorithm SHA256 -LiteralPath $entry.FullName).Hash)")
        }
      }
    }
    $encoded = [System.Text.Encoding]::UTF8.GetBytes(($records -join "`n"))
    return ([System.BitConverter]::ToString($sha.ComputeHash($encoded))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-DefaultUserStateSnapshot {
  $homePath = [Environment]::GetFolderPath('UserProfile')
  $localAppDataPath = [Environment]::GetFolderPath('LocalApplicationData')
  $registryText = & reg.exe query 'HKCU\Software\Mythpen' /s 2>$null
  if ($LASTEXITCODE -ne 0) { $registryText = 'ABSENT' }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $registryDigest = ([System.BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(($registryText -join "`n"))))).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  return [ordered]@{
    data = Get-TreeDigest -Paths @((Join-Path $homePath '.mythpen'))
    control = Get-TreeDigest -Paths @((Join-Path $homePath '.mythpen-control'))
    path_store = Get-TreeDigest -Paths @((Join-Path $homePath '.mythpen-paths.json'))
    webview2 = Get-TreeDigest -Paths @((Join-Path $localAppDataPath 'com.mythpen.desktop'))
    registry = $registryDigest
  }
}

function Compare-DefaultUserStateSnapshots {
  param(
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Before,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$After
  )
  foreach ($label in @('data', 'control', 'path_store', 'webview2', 'registry')) {
    if (-not $Before.Contains($label) -or -not $After.Contains($label) -or $Before[$label] -ne $After[$label]) {
      $label
    }
  }
}

function Get-ExpectedBuildInfo {
  $sourceCommit = (& git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $sourceCommit -notmatch '^[0-9a-f]{40}$') {
    throw 'Unable to resolve the full implementation source commit.'
  }
  $rustc = (& rustc -vV) -join "`n"
  $target = [regex]::Match($rustc, '(?m)^host:\s*(\S+)\s*$').Groups[1].Value
  if (-not $target) { throw 'Unable to resolve the Rust host target triple.' }
  return [ordered]@{ SourceCommit = $sourceCommit; TargetTriple = $target }
}

function Resolve-SidecarPath {
  param([string]$RequestedPath, [string]$TargetTriple)
  if ($RequestedPath) { return (Resolve-Path -LiteralPath $RequestedPath).Path }
  $extension = if ($TargetTriple -match '-windows(?:-|$)') { '.exe' } else { '' }
  $candidate = Join-Path (Get-Location) "src-tauri\binaries\mythpen-server-$TargetTriple$extension"
  if (-not (Test-Path -LiteralPath $candidate)) { throw "Compiled sidecar not found: $candidate" }
  return (Resolve-Path -LiteralPath $candidate).Path
}

function Resolve-DesktopPath {
  param([string]$RequestedPath)
  if ($RequestedPath) { return (Resolve-Path -LiteralPath $RequestedPath).Path }
  $candidate = Join-Path (Get-Location) 'src-tauri\target\debug\mythpen.exe'
  if (-not (Test-Path -LiteralPath $candidate)) { throw "Compiled desktop not found: $candidate" }
  return (Resolve-Path -LiteralPath $candidate).Path
}

function Set-ChildEnvironment {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.ProcessStartInfo]$StartInfo,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Environment
  )
  [MythpenSmokeProcessEnvironment]::Set($StartInfo, $Environment)
}

function New-ChildProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][hashtable]$Environment,
    [string]$Arguments,
    [switch]$RedirectControl
  )
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Executable
  if ($Arguments) { $start.Arguments = $Arguments }
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  if ($RedirectControl) {
    $start.RedirectStandardInput = $true
  }
  Set-ChildEnvironment -StartInfo $start -Environment $Environment
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Failed to start smoke process.' }
  if ($RedirectControl) {
    $process.StandardInput.AutoFlush = $true
    $script:DrainTasks.Add($process.StandardError.ReadToEndAsync())
  } else {
    $script:DrainTasks.Add($process.StandardOutput.ReadToEndAsync())
    $script:DrainTasks.Add($process.StandardError.ReadToEndAsync())
  }
  $script:Processes.Add($process)
  return $process
}

function Invoke-RecoveryNoticeSceneSeeder {
  param([Parameter(Mandatory = $true)][hashtable]$Environment)
  $seedScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'seed-recovery-notice-scene.js'))
  $bun = (Get-Command bun.exe -ErrorAction Stop).Source
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $bun
  $start.Arguments = "`"$seedScript`""
  $start.WorkingDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  Set-ChildEnvironment -StartInfo $start -Environment $Environment
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Failed to start the RecoveryNotice scene seeder.' }
  $script:Processes.Add($process)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { throw 'RecoveryNotice scene seeder timed out.' }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "RecoveryNotice scene seeder failed: $stderr" }
  $line = @($stdout -split "`r?`n" | Where-Object { $_.StartsWith('MYTHPEN_RECOVERY_NOTICE_SCENE ') }) | Select-Object -Last 1
  if (-not $line) { throw 'RecoveryNotice scene seeder did not publish its exact fixture descriptor.' }
  $scene = $line.Substring('MYTHPEN_RECOVERY_NOTICE_SCENE '.Length) | ConvertFrom-Json
  if (
    $scene.reasonCode -ne 'V1_PUBLICATION_FORWARD_RECOVERABLE' -or
    -not $scene.projectName -or
    -not $scene.projectPath -or
    -not $scene.lockRoot
  ) {
    throw 'RecoveryNotice scene seeder published an invalid fixture descriptor.'
  }
  return $scene
}

function Start-RecoveryWriterHold {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Environment,
    [Parameter(Mandatory = $true)][string]$LockRoot,
    [Parameter(Mandatory = $true)][string]$ProjectPath
  )
  $workerScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\server\tests\fixtures\project-write-worker.js'))
  $bun = (Get-Command bun.exe -ErrorAction Stop).Source
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $bun
  $start.Arguments = "`"$workerScript`" hold `"$LockRoot`" `"$ProjectPath`""
  $start.WorkingDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  Set-ChildEnvironment -StartInfo $start -Environment $Environment
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw 'Failed to start the RecoveryNotice external writer.' }
  $script:Processes.Add($process)
  $script:DrainTasks.Add($process.StandardError.ReadToEndAsync())
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $lineTask = $process.StandardOutput.ReadLineAsync()
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if (-not $lineTask.Wait($remaining)) { break }
    $line = $lineTask.Result
    if ($line -eq 'callback') {
      $script:DrainTasks.Add($process.StandardOutput.ReadToEndAsync())
      return $process
    }
    if ($null -eq $line -or $line.StartsWith('error:')) {
      throw "RecoveryNotice external writer did not acquire its project lease: $line"
    }
  }
  throw 'RecoveryNotice external writer timed out before reporting its lease state.'
}

function Stop-RecoveryWriterHold {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  if (-not $Process.HasExited) { $Process.Kill() }
  if (-not $Process.WaitForExit(5000)) { throw 'RecoveryNotice external writer did not terminate.' }
  Start-Sleep -Milliseconds 200
}

function New-DesktopProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Environment
  )
  $processEnvironment = [Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process)
  $originalValues = [ordered]@{}
  foreach ($entry in $Environment.GetEnumerator()) {
    $key = [string]$entry.Key
    $originalValues[$key] = [ordered]@{
      Present = $processEnvironment.Contains($key)
      Value = [Environment]::GetEnvironmentVariable($key, [System.EnvironmentVariableTarget]::Process)
    }
  }
  try {
    foreach ($entry in $Environment.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable(
        [string]$entry.Key,
        [string]$entry.Value,
        [System.EnvironmentVariableTarget]::Process
      )
    }
    $process = Start-Process -FilePath $Executable -PassThru
    $script:Processes.Add($process)
    $null = $process.Handle
    return $process
  } finally {
    foreach ($entry in $originalValues.GetEnumerator()) {
      $original = $entry.Value
      [Environment]::SetEnvironmentVariable(
        [string]$entry.Key,
        $(if ($original.Present) { [string]$original.Value } else { $null }),
        [System.EnvironmentVariableTarget]::Process
      )
    }
  }
}

function Register-OwnedProcessObject {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$ParentProcess,
    [Parameter(Mandatory = $true)][int]$ChildPid,
    [Parameter(Mandatory = $true)][string]$ExpectedNamePrefix,
    [string]$ExpectedExecutablePath
  )
  $normalizedExpectedPath = if ($ExpectedExecutablePath) { [System.IO.Path]::GetFullPath($ExpectedExecutablePath) } else { $null }
  $before = Get-CimInstance Win32_Process -Filter "ProcessId = $ChildPid"
  if (
    -not $before -or
    [int]$before.ParentProcessId -ne $ParentProcess.Id -or
    -not ([string]$before.Name).StartsWith($ExpectedNamePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    ($normalizedExpectedPath -and (
      -not $before.ExecutablePath -or
      -not [System.IO.Path]::GetFullPath([string]$before.ExecutablePath).Equals($normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)
    ))
  ) {
    throw 'Published child PID did not identify the expected direct owned process.'
  }

  $ownedProcess = [System.Diagnostics.Process]::GetProcessById($ChildPid)
  $retainedForCleanup = $false
  try {
    # Force a persistent process handle now. Later HasExited/Kill calls therefore
    # retain this process identity even if Windows reuses the numeric PID.
    $null = $ownedProcess.Handle
    # Once the exact parent/name/path preflight and handle acquisition succeed,
    # global cleanup owns this identity even if the secondary identity audit fails.
    $script:Processes.Add($ownedProcess)
    $retainedForCleanup = $true
    $after = Get-CimInstance Win32_Process -Filter "ProcessId = $ChildPid"
    $beforeCreated = ([DateTime]$before.CreationDate).ToUniversalTime()
    $afterCreated = ([DateTime]$after.CreationDate).ToUniversalTime()
    $processStarted = $ownedProcess.StartTime.ToUniversalTime()
    $matchingDirectChildren = @(if ($normalizedExpectedPath) {
      Get-CimInstance Win32_Process -Filter "ParentProcessId = $($ParentProcess.Id)" | Where-Object {
        $_.ExecutablePath -and
        [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals($normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)
      }
    } else { $after })
    if (
      -not $after -or
      [int]$after.ParentProcessId -ne $ParentProcess.Id -or
      -not ([string]$after.Name).StartsWith($ExpectedNamePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
      ($normalizedExpectedPath -and (
        -not $after.ExecutablePath -or
        -not [System.IO.Path]::GetFullPath([string]$after.ExecutablePath).Equals($normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $matchingDirectChildren.Count -ne 1 -or
        [int]$matchingDirectChildren[0].ProcessId -ne $ChildPid
      )) -or
      $beforeCreated -ne $afterCreated -or
      [Math]::Abs(($processStarted - $afterCreated).TotalSeconds) -gt 2
    ) {
      throw 'Owned process identity changed while acquiring its retained handle.'
    }
    return $ownedProcess
  } catch {
    if (-not $retainedForCleanup) { $ownedProcess.Dispose() }
    throw
  }
}

function Wait-RegisterDesktopOwnedChildBeforeSession {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$DesktopProcess,
    [Parameter(Mandatory = $true)][string]$DesktopExecutable
  )
  $expectedChildPath = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($DesktopExecutable))) 'mythpen-server.exe'))
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($DesktopProcess.HasExited) { throw 'Desktop exited before its exact owned sidecar could be retained.' }
    $namedChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($DesktopProcess.Id)" | Where-Object {
      ([string]$_.Name).Equals('mythpen-server.exe', [System.StringComparison]::OrdinalIgnoreCase)
    })
    if ($namedChildren.Count -gt 1) { throw 'Desktop spawned more than one direct mythpen-server child before session publication.' }
    if ($namedChildren.Count -eq 1) {
      $candidate = $namedChildren[0]
      if (-not $candidate.ExecutablePath) {
        Start-Sleep -Milliseconds 25
        continue
      }
      $candidatePath = [System.IO.Path]::GetFullPath([string]$candidate.ExecutablePath)
      if (-not $candidatePath.Equals($expectedChildPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Desktop spawned a same-named child from an unexpected executable path.'
      }
      return Register-OwnedProcessObject -ParentProcess $DesktopProcess -ChildPid ([int]$candidate.ProcessId) -ExpectedNamePrefix 'mythpen-server.exe' -ExpectedExecutablePath $expectedChildPath
    }
    Start-Sleep -Milliseconds 25
  }
  throw 'Timed out retaining the exact desktop-owned sidecar before session publication.'
}

function Write-ControlFrame {
  param([System.Diagnostics.Process]$Process, [hashtable]$Frame)
  $Process.StandardInput.WriteLine(($Frame | ConvertTo-Json -Compress))
  $Process.StandardInput.Flush()
}

function Write-ControlFrames {
  param([System.Diagnostics.Process]$Process, [hashtable[]]$Frames)
  $lines = $Frames | ForEach-Object { $_ | ConvertTo-Json -Compress }
  $Process.StandardInput.Write(($lines -join "`n") + "`n")
  $Process.StandardInput.Flush()
}

function Read-ControlFrame {
  param([System.Diagnostics.Process]$Process, [int]$TimeoutMilliseconds = 30000)
  $task = $Process.StandardOutput.ReadLineAsync()
  if (-not $task.Wait($TimeoutMilliseconds)) { throw 'Timed out waiting for a sidecar control frame.' }
  $line = $task.Result
  if ($null -eq $line) { throw 'Sidecar control stream ended unexpectedly.' }
  try { return $line | ConvertFrom-Json } catch { throw 'Sidecar emitted non-JSON stdout.' }
}

function Read-UntilFrame {
  param(
    [System.Diagnostics.Process]$Process,
    [string[]]$Types,
    [int]$TimeoutMilliseconds = 30000
  )
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    $frame = Read-ControlFrame -Process $Process -TimeoutMilliseconds $remaining
    if ($frame.channel -eq 'mythpen.sidecar.v1' -and $Types -contains [string]$frame.type) { return $frame }
  }
  throw "Timed out waiting for frame: $($Types -join ', ')"
}

function Start-OwnedSidecar {
  param(
    [string]$Executable,
    [hashtable]$Environment,
    [string]$Nonce,
    [hashtable]$Expected
  )
  $childEnvironment = [ordered]@{}
  foreach ($entry in $Environment.GetEnumerator()) { $childEnvironment[$entry.Key] = $entry.Value }
  $childEnvironment.MYTHPEN_DESKTOP_OWNED = '1'
  $childEnvironment.PORT = '0'
  $process = New-ChildProcess -Executable $Executable -Environment $childEnvironment -RedirectControl
  Write-ControlFrame -Process $process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'bootstrap'; nonce = $Nonce }
  $ready = Read-UntilFrame -Process $process -Types @('ready') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
  Write-ControlFrame -Process $process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'build.info.request'; nonce = $Nonce }
  $buildInfo = Read-UntilFrame -Process $process -Types @('build.info') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
  $expectedNonceDigest = Get-NonceDigest -Nonce $Nonce
  if ([int]$ready.childPid -ne $process.Id -or $ready.nonceDigest -ne $expectedNonceDigest) {
    throw 'Ready frame was not bound to the actual child PID and decoded raw nonce digest.'
  }
  foreach ($frame in @($ready, $buildInfo)) {
    if ($frame.nativeActivationMode -ne 'off' -or $frame.sourceCommit -ne $Expected.SourceCommit -or $frame.targetTriple -ne $Expected.TargetTriple) {
      throw 'Compiled sidecar build metadata did not match off/full commit/target triple.'
    }
  }
  if (
    [int]$buildInfo.childPid -ne [int]$ready.childPid -or
    $buildInfo.nonceDigest -ne $ready.nonceDigest -or
    $buildInfo.nativeActivationMode -ne $ready.nativeActivationMode -or
    $buildInfo.sourceCommit -ne $ready.sourceCommit -or
    $buildInfo.targetTriple -ne $ready.targetTriple
  ) {
    throw 'Authenticated build.info did not exactly match the ready identity and build tuple.'
  }
  if ($ready.host -ne '127.0.0.1' -or [int]$ready.port -le 0) { throw 'Sidecar did not bind a dynamic loopback endpoint.' }
  return [ordered]@{ Process = $process; Ready = $ready; BuildInfo = $buildInfo; Nonce = $Nonce }
}

function Get-HttpStatus {
  param(
    [int]$Port,
    [string]$Nonce,
    [string]$Path = '/api/health',
    [ValidateSet('GET', 'POST', 'PUT', 'PATCH', 'DELETE')][string]$Method = 'GET',
    [string]$Body
  )
  $request = @{
    UseBasicParsing = $true
    Uri = "http://127.0.0.1:$Port$Path"
    Headers = @{ 'X-Mythpen-Instance-Nonce' = $Nonce }
    Method = $Method
    TimeoutSec = 10
  }
  if ($PSBoundParameters.ContainsKey('Body')) {
    $request.Body = $Body
    $request.ContentType = 'application/json'
  }
  try {
    $response = Invoke-WebRequest @request
    return [int]$response.StatusCode
  } catch {
    if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
    throw
  }
}

function Assert-HttpNonceRejected {
  param([hashtable]$Owned, [string]$CandidateNonce)
  $probes = @(
    @{ Class = 'health'; Path = '/api/health'; Method = 'GET' },
    @{ Class = 'json'; Path = '/api/projects'; Method = 'GET' },
    @{ Class = 'sse'; Path = '/api/ai/chat/stream'; Method = 'POST'; Body = '{}' },
    @{ Class = 'blob'; Path = '/api/nonexistent/cover'; Method = 'GET' }
  )
  foreach ($probe in $probes) {
    if ($probe.ContainsKey('Body')) {
      $status = Get-HttpStatus -Port ([int]$Owned.Ready.port) -Nonce $CandidateNonce -Path $probe.Path -Method $probe.Method -Body $probe.Body
    } else {
      $status = Get-HttpStatus -Port ([int]$Owned.Ready.port) -Nonce $CandidateNonce -Path $probe.Path -Method $probe.Method
    }
    if ($status -ne 401) { throw "$($probe.Class) endpoint did not reject a non-matching nonce with 401." }
  }
}

function Assert-ControlNonceRejected {
  param([hashtable]$Owned, [string]$CandidateNonce)
  Write-ControlFrame -Process $Owned.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'build.info.request'; nonce = $CandidateNonce }
  $rejected = Read-UntilFrame -Process $Owned.Process -Types @('control.error') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
  if ($rejected.code -ne 'CONTROL_AUTH_FAILED') { throw 'Control channel did not reject a non-matching nonce with CONTROL_AUTH_FAILED.' }

  Write-ControlFrame -Process $Owned.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'build.info.request'; nonce = $Owned.Nonce }
  $accepted = Read-UntilFrame -Process $Owned.Process -Types @('build.info', 'control.error') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
  if (
    $accepted.type -ne 'build.info' -or
    $accepted.nativeActivationMode -ne $Owned.BuildInfo.nativeActivationMode -or
    $accepted.sourceCommit -ne $Owned.BuildInfo.sourceCommit -or
    $accepted.targetTriple -ne $Owned.BuildInfo.targetTriple
  ) {
    throw 'Correct control nonce was not usable after an authentication rejection.'
  }
}

function Wait-ShutdownSequence {
  param(
    [hashtable]$Owned,
    [int]$AttemptSeq,
    [string[]]$ExpectedStates,
    [string[]]$TerminalTypes = @(),
    [string]$TerminalState
  )
  $observedStates = [System.Collections.Generic.List[string]]::new()
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    $remaining = [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    $frame = Read-ControlFrame -Process $Owned.Process -TimeoutMilliseconds $remaining
    if ($frame.channel -ne 'mythpen.sidecar.v1') { continue }
    $type = [string]$frame.type
    if ($type.StartsWith('shutdown.') -and [int]$frame.attemptSeq -ne $AttemptSeq) {
      throw 'Shutdown frame attemptSeq did not match the active attempt.'
    }
    if ($type -eq 'shutdown.state') {
      $index = $observedStates.Count
      if ($index -ge $ExpectedStates.Count -or [string]$frame.state -ne $ExpectedStates[$index]) {
        throw "Shutdown phase order mismatch at state $($frame.state)."
      }
      $observedStates.Add([string]$frame.state)
      if ($TerminalState -and $frame.state -eq $TerminalState) {
        if ($observedStates.Count -ne $ExpectedStates.Count) { throw 'Shutdown state sequence ended early.' }
        return [ordered]@{ Frame = $frame; States = @($observedStates) }
      }
      continue
    }
    if ($TerminalTypes -contains $type) {
      if ($observedStates.Count -ne $ExpectedStates.Count) { throw "Shutdown terminal frame $type arrived before the required phase sequence." }
      return [ordered]@{ Frame = $frame; States = @($observedStates) }
    }
    if ($type -in @('shutdown.failed', 'control.error')) {
      throw "Shutdown sequence failed with $type/$($frame.code)."
    }
  }
  throw 'Timed out waiting for the required shutdown sequence.'
}

function Complete-OwnedSidecarExit {
  param([hashtable]$Owned)
  try { $Owned.Process.StandardInput.Close() } catch { }
  if (-not $Owned.Process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Sidecar did not terminate after shutdown.complete.' }
  if ($Owned.Process.ExitCode -ne 0) { throw "Sidecar exited with code $($Owned.Process.ExitCode) after a clean shutdown." }
}

function Stop-OwnedSidecarClean {
  param([hashtable]$Owned, [int]$AttemptSeq = 1)
  Write-ControlFrame -Process $Owned.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.request'; nonce = $Owned.Nonce; attemptSeq = $AttemptSeq }
  $sequence = Wait-ShutdownSequence -Owned $Owned -AttemptSeq $AttemptSeq -ExpectedStates @('quiescing', 'draining', 'closing') -TerminalTypes @('shutdown.complete')
  $complete = $sequence.Frame
  if ($complete.type -ne 'shutdown.complete' -or [int]$complete.attemptSeq -ne $AttemptSeq) { throw 'Sidecar did not complete a clean shutdown.' }
  Complete-OwnedSidecarExit -Owned $Owned
}

function Start-HeldAiRequest {
  param([hashtable]$Owned)
  Add-Type -AssemblyName System.Net.Http
  $provider = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $provider.Start()
  $providerPort = ([System.Net.IPEndPoint]$provider.LocalEndpoint).Port
  $providerAccept = $provider.AcceptTcpClientAsync()
  $httpClient = [System.Net.Http.HttpClient]::new()
  $httpClient.DefaultRequestHeaders.Add('X-Mythpen-Instance-Nonce', $Owned.Nonce)
  $aiBody = @{
    messages = @(@{ role = 'user'; content = 'hold this request open' })
    apiKey = 'smoke-key'
    apiBaseUrl = "http://127.0.0.1:$providerPort/v1"
    apiModel = 'gpt-smoke'
  } | ConvertTo-Json -Compress -Depth 5
  $aiContent = [System.Net.Http.StringContent]::new($aiBody, [System.Text.Encoding]::UTF8, 'application/json')
  try {
    $aiRequest = $httpClient.PostAsync("http://127.0.0.1:$($Owned.Ready.port)/api/ai/chat", $aiContent)
    if (-not $providerAccept.Wait(10000)) { throw 'Sidecar did not connect to the local held AI provider.' }
    return [ordered]@{
      Provider = $provider
      ProviderConnection = $providerAccept.Result
      HttpClient = $httpClient
      Content = $aiContent
      Request = $aiRequest
    }
  } catch {
    $httpClient.Dispose()
    $aiContent.Dispose()
    $provider.Stop()
    throw
  }
}

function Release-HeldAiRequest {
  param([hashtable]$Hold)
  if (-not $Hold) { return }
  try { $Hold.ProviderConnection.Dispose() } catch { }
  try { $Hold.Provider.Stop() } catch { }
  try { $Hold.HttpClient.Dispose() } catch { }
  try { $Hold.Content.Dispose() } catch { }
}

function Invoke-SidecarMatrix {
  param([string]$Executable, [hashtable]$Expected)
  $fake3001 = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 3001)
  $fake3001.Start()
  $script:FakePortListener = $fake3001
  $sceneA = New-SmokeEnvironment -Label 'sidecar-a'
  $sceneB = New-SmokeEnvironment -Label 'sidecar-b'
  $a = $null
  $b = $null
  try {
    $envA = [ordered]@{}
    foreach ($entry in $sceneA.Environment.GetEnumerator()) { $envA[$entry.Key] = $entry.Value }
    $envA.MYTHPEN_NATIVE_ACTIVATION_MODE = 'production'
    $a = Start-OwnedSidecar -Executable $Executable -Environment $envA -Nonce (New-RandomHex) -Expected $Expected
    $b = Start-OwnedSidecar -Executable $Executable -Environment $sceneB.Environment -Nonce (New-RandomHex) -Expected $Expected
    if ([int]$a.Ready.port -eq 3001 -or [int]$b.Ready.port -eq 3001) { throw 'Dynamic sidecar reused occupied port 3001.' }
    Add-SmokeResult 'fake3001' 'PASS' 'Two compiled sidecars used non-3001 dynamic loopback ports while 3001 was occupied.'
    Add-SmokeResult 'ready_build_info' 'PASS' 'Both compiled sidecars reported off, full implementation commit, and the host target triple.'
    Add-SmokeResult 'runtime_mode_bypass' 'PASS' 'A production-valued runtime environment variable did not change compiled mode off.'
    Assert-HttpNonceRejected -Owned $a -CandidateNonce ('0' * 64)
    Assert-ControlNonceRejected -Owned $a -CandidateNonce ('0' * 64)
    Add-SmokeResult 'wrong_nonce' 'PASS' 'Wrong nonce was rejected by health, JSON, SSE, blob, and control classes; the correct control nonce remained usable.'
    Assert-HttpNonceRejected -Owned $b -CandidateNonce $a.Nonce
    Assert-ControlNonceRejected -Owned $b -CandidateNonce $a.Nonce
    if ((Get-HttpStatus -Port ([int]$a.Ready.port) -Nonce $a.Nonce) -ne 200) { throw 'Matching nonce did not authenticate.' }
    Add-SmokeResult 'cross_instance_nonce' 'PASS' 'Nonce A failed against sidecar B across health, JSON, SSE, blob, and control while matching nonces remained usable.'
    Stop-OwnedSidecarClean -Owned $a
    Add-SmokeResult 'normal_shutdown' 'PASS' 'Compiled sidecar emitted quiescing, draining, closing, complete in strict order and exited naturally with code 0.'
    Stop-OwnedSidecarClean -Owned $b
  } finally {
    $fake3001.Stop()
    $script:FakePortListener = $null
  }

  $cancelScene = New-SmokeEnvironment -Label 'cancel'
  $cancel = Start-OwnedSidecar -Executable $Executable -Environment $cancelScene.Environment -Nonce (New-RandomHex) -Expected $Expected
  Write-ControlFrames -Process $cancel.Process -Frames @(
    @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.request'; nonce = $cancel.Nonce; attemptSeq = 1 },
    @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.cancel'; nonce = $cancel.Nonce; attemptSeq = 1 }
  )
  $cancelledSequence = Wait-ShutdownSequence -Owned $cancel -AttemptSeq 1 -ExpectedStates @('quiescing') -TerminalTypes @('shutdown.cancelled')
  $cancelled = $cancelledSequence.Frame
  if ($cancelled.type -ne 'shutdown.cancelled' -or [int]$cancelled.attemptSeq -ne 1) { throw 'Pre-closing cancellation was not accepted.' }
  Write-ControlFrame -Process $cancel.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.continue_wait'; nonce = $cancel.Nonce; attemptSeq = 1 }
  $staleContinuation = Read-UntilFrame -Process $cancel.Process -Types @('control.error') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
  if ($staleContinuation.code -ne 'CONTROL_INVALID_STATE') { throw 'A retired shutdown attempt did not stably reject stale continue_wait.' }
  $admissionStatus = Get-HttpStatus -Port ([int]$cancel.Ready.port) -Nonce $cancel.Nonce -Path '/api/ai/chat/stream' -Method 'POST' -Body '{}'
  if ($admissionStatus -eq 503) { throw 'Mutation admission was not restored after cancellation.' }
  Stop-OwnedSidecarClean -Owned $cancel -AttemptSeq 2
  Add-SmokeResult 'cancel_shutdown' 'PASS' 'A same-batch pre-closing cancel retired attempt 1, rejected its stale continue_wait, restored mutation admission, and attemptSeq 2 shut down cleanly.'
  Add-SmokeResult 'slow_drain_cancel' 'NOT_RUN' 'Production exposes no asynchronous project-writer hold; a held AI request reaches soft_deadline only after the lifecycle has entered closing.'

  $continueScene = New-SmokeEnvironment -Label 'continue'
  $continue = Start-OwnedSidecar -Executable $Executable -Environment $continueScene.Environment -Nonce (New-RandomHex) -Expected $Expected
  $continueHold = Start-HeldAiRequest -Owned $continue
  $continueHoldReleased = $false
  try {
    Write-ControlFrame -Process $continue.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.request'; nonce = $continue.Nonce; attemptSeq = 1 }
    $continueDeadline = Wait-ShutdownSequence -Owned $continue -AttemptSeq 1 -ExpectedStates @('quiescing', 'draining', 'closing') -TerminalTypes @('shutdown.soft_deadline')
    if ($continueDeadline.Frame.state -ne 'closing') { throw 'Active AI request did not hold shutdown in closing.' }
    Write-ControlFrame -Process $continue.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.cancel'; nonce = $continue.Nonce; attemptSeq = 1 }
    $tooLate = Read-UntilFrame -Process $continue.Process -Types @('control.error', 'shutdown.complete') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
    if ($tooLate.type -ne 'control.error' -or $tooLate.code -ne 'CONTROL_CANCEL_TOO_LATE') {
      throw 'Cancellation after closing was not rejected with CONTROL_CANCEL_TOO_LATE.'
    }
    Write-ControlFrame -Process $continue.Process -Frame @{ channel = 'mythpen.sidecar.v1'; type = 'shutdown.continue_wait'; nonce = $continue.Nonce; attemptSeq = 1 }
    Release-HeldAiRequest -Hold $continueHold
    $continueHoldReleased = $true
  } finally {
    if (-not $continueHoldReleased) { Release-HeldAiRequest -Hold $continueHold }
  }
  $continuedComplete = Read-UntilFrame -Process $continue.Process -Types @('shutdown.complete', 'shutdown.failed', 'control.error') -TimeoutMilliseconds ($TimeoutSeconds * 1000)
  if ($continuedComplete.type -ne 'shutdown.complete') { throw 'Continue-wait scenario did not finish cleanly.' }
  Complete-OwnedSidecarExit -Owned $continue
  Add-SmokeResult 'closing_cancel_rejected' 'PASS' 'A held AI request kept closing active; cancel was rejected as too late with CONTROL_CANCEL_TOO_LATE.'
  Add-SmokeResult 'continue_wait' 'PASS' 'The same closing soft deadline accepted continue_wait and completed cleanly after the held request was released.'
}

function Assert-DesktopProcessesReadyForCdp {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$DesktopProcess,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$OwnedChild,
    [IntPtr]$TauriWindowHandle = [IntPtr]::Zero,
    [switch]$RequireResponsiveWindow
  )
  if ($DesktopProcess.HasExited) { throw 'Desktop process exited before CDP readiness was established.' }
  if ($OwnedChild.HasExited) { throw 'Desktop-owned sidecar exited before CDP readiness was established.' }
  if (
    $TauriWindowHandle -ne [IntPtr]::Zero -and
    -not [MythpenSmokeWindow]::IsTauriMainWindowForProcess($TauriWindowHandle, $DesktopProcess.Id)
  ) {
    throw 'The selected Tauri application window disappeared or changed identity before CDP readiness.'
  }
  if ($RequireResponsiveWindow) {
    if ($TauriWindowHandle -eq [IntPtr]::Zero) { throw 'No Tauri application window was selected before the CDP readiness timeout.' }
    if (-not [MythpenSmokeWindow]::IsResponsive($TauriWindowHandle)) { throw 'The Tauri application window was unresponsive at the CDP readiness timeout.' }
  }
}

function Wait-TauriMainWindow {
  param(
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$DesktopProcess,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$OwnedChild
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-DesktopProcessesReadyForCdp -DesktopProcess $DesktopProcess -OwnedChild $OwnedChild
    $matches = @([MythpenSmokeWindow]::FindTauriMainWindows($DesktopProcess.Id))
    if ($matches.Count -gt 1) { throw 'Desktop exposed multiple visible Tauri Window instances titled Mythpen.' }
    if ($matches.Count -eq 1 -and [MythpenSmokeWindow]::IsResponsive($matches[0])) {
      return [IntPtr]$matches[0]
    }
    Start-Sleep -Milliseconds 25
  }
  Assert-DesktopProcessesReadyForCdp -DesktopProcess $DesktopProcess -OwnedChild $OwnedChild
  throw 'Desktop did not expose exactly one responsive visible Tauri Window titled Mythpen before the smoke timeout.'
}

function Assert-CdpListenerOwnedByDesktopWebView {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$WebView2Root,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$DesktopProcess
  )
  $controlledWebViewRoot = [System.IO.Path]::GetFullPath($WebView2Root).TrimEnd('\', '/')
  $cdpListenerErrors = @()
  $listeners = @(
    Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue -ErrorVariable cdpListenerErrors |
      Where-Object { ([string]$_.LocalAddress).Equals('127.0.0.1', [System.StringComparison]::Ordinal) }
  )
  $unexpectedListenerError = @($cdpListenerErrors | Where-Object {
    $_.FullyQualifiedErrorId -notlike 'CmdletizationQuery_NotFound*' -or
    $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound
  } | Select-Object -First 1)
  if ($unexpectedListenerError.Count -gt 0) { throw $unexpectedListenerError[0] }
  if ($listeners.Count -eq 0) { return $false }
  $ownerPids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($ownerPids.Count -ne 1) { throw 'The reserved CDP port was claimed by multiple listener processes.' }

  $currentPid = [int]$ownerPids[0]
  $visited = [System.Collections.Generic.HashSet[int]]::new()
  $reachedDesktop = $false
  $matchedControlledWebView = $false
  for ($depth = 0; $depth -lt 16 -and $currentPid -gt 0; $depth += 1) {
    if (-not $visited.Add($currentPid)) { throw 'CDP listener process ancestry contained a cycle.' }
    if ($currentPid -eq $DesktopProcess.Id) {
      $reachedDesktop = $true
      break
    }
    $processRecord = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid"
    if (-not $processRecord) { throw 'CDP listener owner disappeared during identity verification.' }
    if (([string]$processRecord.Name).Equals('msedgewebview2.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
      $commandLine = [string]$processRecord.CommandLine
      if (
        $commandLine.IndexOf($controlledWebViewRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine.IndexOf("--remote-debugging-port=$Port", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      ) {
        $matchedControlledWebView = $true
      }
    }
    $currentPid = [int]$processRecord.ParentProcessId
  }
  if (-not $reachedDesktop -or -not $matchedControlledWebView) {
    throw 'The reserved CDP port was not owned by the controlled WebView2 descendant of this desktop process.'
  }
  return $true
}

function Get-CdpTarget {
  param(
    [int]$Port,
    [Parameter(Mandatory = $true)][string]$WebView2Root,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$DesktopProcess,
    [Parameter(Mandatory = $true)][System.Diagnostics.Process]$OwnedChild,
    [IntPtr]$TauriWindowHandle = [IntPtr]::Zero
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-DesktopProcessesReadyForCdp -DesktopProcess $DesktopProcess -OwnedChild $OwnedChild -TauriWindowHandle $TauriWindowHandle
    if (-not (Assert-CdpListenerOwnedByDesktopWebView -Port $Port -WebView2Root $WebView2Root -DesktopProcess $DesktopProcess)) {
      Start-Sleep -Milliseconds 25
      continue
    }
    $targets = $null
    try {
      $targets = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 2
    } catch { Start-Sleep -Milliseconds 200 }
    if (-not $targets) { continue }
    $target = $targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
    if (-not $target) {
      Start-Sleep -Milliseconds 200
      continue
    }
    $webSocketUri = [uri]$target.webSocketDebuggerUrl
    [System.Net.IPAddress]$parsedAddress = $null
    $isLoopback = (
      [System.Net.IPAddress]::TryParse($webSocketUri.Host, [ref]$parsedAddress) -and
      [System.Net.IPAddress]::IsLoopback($parsedAddress)
    ) -or $webSocketUri.Host.Equals('localhost', [System.StringComparison]::OrdinalIgnoreCase)
    if ($webSocketUri.Scheme -ne 'ws' -or -not $isLoopback -or $webSocketUri.Port -ne $Port) {
      throw 'DevTools target advertised a non-loopback or mismatched WebSocket endpoint.'
    }
    return $target
  }
  Assert-DesktopProcessesReadyForCdp -DesktopProcess $DesktopProcess -OwnedChild $OwnedChild -TauriWindowHandle $TauriWindowHandle -RequireResponsiveWindow
  throw [MythpenSmokeDesktopCdpUnavailableException]::new(
    'Controlled WebView2 did not expose its reserved loopback CDP endpoint before the smoke timeout.'
  )
}

function Invoke-CdpExpression {
  param([string]$WebSocketUrl, [string]$Expression)
  $socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $timeout = [System.Threading.CancellationTokenSource]::new($TimeoutSeconds * 1000)
  try {
    $null = $socket.ConnectAsync([uri]$WebSocketUrl, $timeout.Token).GetAwaiter().GetResult()
    $payload = @{ id = 1; method = 'Runtime.evaluate'; params = @{ expression = $Expression; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 8
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    [System.ArraySegment[byte]]$send = $bytes
    $null = $socket.SendAsync($send, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $timeout.Token).GetAwaiter().GetResult()
    $buffer = New-Object byte[] 65536
    $stream = [System.IO.MemoryStream]::new()
    do {
      [System.ArraySegment[byte]]$receive = $buffer
      $received = $socket.ReceiveAsync($receive, $timeout.Token).GetAwaiter().GetResult()
      $stream.Write($buffer, 0, $received.Count)
    } while (-not $received.EndOfMessage)
    $response = [System.Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
    $errorProperty = $response.PSObject.Properties['error']
    if ($errorProperty -and $errorProperty.Value) {
      $codeProperty = $errorProperty.Value.PSObject.Properties['code']
      $safeCode = if ($codeProperty -and $codeProperty.Value -match '^-?\d+$') { [string]$codeProperty.Value } else { 'unknown' }
      throw "CDP_PROTOCOL_ERROR code=$safeCode"
    }
    $resultProperty = $response.PSObject.Properties['result']
    if (-not $resultProperty -or -not $resultProperty.Value) { throw 'CDP_PROTOCOL_ERROR missing_result' }
    $resultEnvelope = $resultProperty.Value
    $exceptionProperty = $resultEnvelope.PSObject.Properties['exceptionDetails']
    if ($exceptionProperty -and $exceptionProperty.Value) {
      $lineProperty = $exceptionProperty.Value.PSObject.Properties['lineNumber']
      $columnProperty = $exceptionProperty.Value.PSObject.Properties['columnNumber']
      $safeLine = if ($lineProperty) { [int]$lineProperty.Value } else { -1 }
      $safeColumn = if ($columnProperty) { [int]$columnProperty.Value } else { -1 }
      throw "CDP_EVALUATION_ERROR line=$safeLine column=$safeColumn"
    }
    $remoteResultProperty = $resultEnvelope.PSObject.Properties['result']
    if (-not $remoteResultProperty -or -not $remoteResultProperty.Value) { throw 'CDP_PROTOCOL_ERROR missing_remote_result' }
    $valueProperty = $remoteResultProperty.Value.PSObject.Properties['value']
    if (-not $valueProperty) { return $null }
    return $valueProperty.Value
  } finally {
    $socket.Dispose()
    $timeout.Dispose()
  }
}

function Wait-DesktopSession {
  param([object]$Target, [hashtable]$Expected)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastSessionError = 'authenticated session was not published'
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $session = Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression "window.__TAURI_INTERNALS__.invoke('get_sidecar_session')"
    } catch {
      $lastSessionError = [string]$_.Exception.Message
      Start-Sleep -Milliseconds 200
      continue
    }
    $portProperty = if ($session) { $session.PSObject.Properties['port'] } else { $null }
    if ($portProperty -and $portProperty.Value) {
      $buildInfoProperty = $session.PSObject.Properties['buildInfo']
      if (-not $buildInfoProperty -or -not $buildInfoProperty.Value) {
        throw 'Desktop-published session omitted authenticated build metadata.'
      }
      $buildInfo = $buildInfoProperty.Value
      if ($buildInfo.nativeActivationMode -ne 'off' -or $buildInfo.sourceCommit -ne $Expected.SourceCommit -or $buildInfo.targetTriple -ne $Expected.TargetTriple) {
        throw 'Desktop-published session build metadata mismatch.'
      }
      return $session
    }
    $lastSessionError = 'authenticated session remained null or not ready'
    Start-Sleep -Milliseconds 200
  }
  throw "Timed out waiting for the authenticated desktop sidecar session. Last CDP/invoke state: $lastSessionError"
}

function Start-DebugDesktop {
  param([string]$Executable, [hashtable]$Environment, [string]$SceneRoot, [string]$FaultMap)
  $desktopEnvironment = [ordered]@{}
  foreach ($entry in $Environment.GetEnumerator()) { $desktopEnvironment[$entry.Key] = $entry.Value }
  $cdpPortLease = New-ControlledCdpPortLease
  $desktopEnvironment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$($cdpPortLease.Port) --remote-allow-origins=*"
  if ($FaultMap) { $desktopEnvironment.MYTHPEN_FAULT_MAP = $FaultMap }
  try {
    # Release immediately before spawn. The post-start ownership check rejects
    # any process that wins this narrow bind race instead of attaching to it.
    $cdpPortLease.Listener.Stop()
    $process = New-DesktopProcess -Executable $Executable -Environment $desktopEnvironment
  } finally {
    $cdpPortLease.Listener.Stop()
  }
  $ownedChild = Wait-RegisterDesktopOwnedChildBeforeSession -DesktopProcess $process -DesktopExecutable $Executable
  $windowHandle = Wait-TauriMainWindow -DesktopProcess $process -OwnedChild $ownedChild
  $target = Get-CdpTarget -Port ([int]$cdpPortLease.Port) -WebView2Root ([string]$desktopEnvironment.WEBVIEW2_USER_DATA_FOLDER) -DesktopProcess $process -OwnedChild $ownedChild -TauriWindowHandle $windowHandle
  return [ordered]@{ Process = $process; OwnedChild = $ownedChild; WindowHandle = $windowHandle; Target = $target; Environment = $desktopEnvironment }
}

function Wait-CdpExpressionTrue {
  param([object]$Target, [string]$Expression, [string]$FailureMessage)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      if (Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression $Expression) { return }
    } catch { }
    Start-Sleep -Milliseconds 100
  }
  throw $FailureMessage
}

function Wait-CdpDialogButtonCount {
  param([object]$Target, [int]$ExpectedCount)
  $expression = "(() => { const buttons = Array.from(document.querySelectorAll('[role=dialog] button:not([disabled])')); return buttons.length === $ExpectedCount; })()"
  Wait-CdpExpressionTrue -Target $Target -Expression $expression -FailureMessage "Dialog did not expose exactly $ExpectedCount enabled buttons."
}

function Click-CdpDialogButton {
  param([object]$Target, [int]$ExpectedCount, [int]$Index)
  $expression = "(() => { const buttons = Array.from(document.querySelectorAll('[role=dialog] button:not([disabled])')); if (buttons.length !== $ExpectedCount) return false; buttons[$Index].click(); return true; })()"
  if (-not (Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression $expression)) {
    throw 'Unable to click the expected real shutdown dialog button.'
  }
}

function Wait-CdpEmergencyConfirmation {
  param([object]$Target)
  $expression = "(() => { const dialog = document.querySelector('[role=dialog]'); if (!dialog) return false; const buttons = Array.from(dialog.querySelectorAll('button:not([disabled])')); return buttons.length === 2 && dialog.querySelectorAll('button.btn-primary').length === 0; })()"
  Wait-CdpExpressionTrue -Target $Target -Expression $expression -FailureMessage 'Rendered shutdown dialog did not enter its two-button emergency confirmation state.'
}

function Initialize-RecoveryNoticeRequestProbe {
  param([object]$Target, [object]$Session)
  $nonceJson = ([string]$Session.nonce | ConvertTo-Json -Compress)
  $expression = @"
(() => {
  const expectedNonce = $nonceJson;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.__mythpenRecoveryExpectedNonce = expectedNonce;
  globalThis.__mythpenRecoveryRequests = [];
  globalThis.__mythpenDelayNextDiagnostics = false;
  globalThis.fetch = async (input, init = {}) => {
    const record = {
      method: String(init.method || 'GET').toUpperCase(),
      nonce: new Headers(init.headers).get('X-Mythpen-Instance-Nonce'),
      status: null,
      url: String(input),
    };
    globalThis.__mythpenRecoveryRequests.push(record);
    if (
      globalThis.__mythpenDelayNextDiagnostics === true &&
      record.method === 'GET' &&
      record.url.endsWith('/diagnostics')
    ) {
      globalThis.__mythpenDelayNextDiagnostics = false;
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const response = await originalFetch(input, init);
    record.status = response.status;
    return response;
  };
  return true;
})()
"@
  if (-not (Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression $expression)) {
    throw 'Unable to install the RecoveryNotice request probe.'
  }
}

function Enter-RecoveryProjectByKeyboard {
  param([object]$Target, [string]$ProjectName)
  $projectJson = ($ProjectName | ConvertTo-Json -Compress)
  $cardExpression = "(() => Array.from(document.querySelectorAll('[role=button]')).some((element) => element.tabIndex === 0 && String(element.textContent).includes($projectJson)))()"
  Wait-CdpExpressionTrue -Target $Target -Expression $cardExpression -FailureMessage 'Isolated project card did not render.'
  $enterExpression = "(() => { const card = Array.from(document.querySelectorAll('[role=button]')).find((element) => element.tabIndex === 0 && String(element.textContent).includes($projectJson)); if (!card) return false; card.focus(); if (document.activeElement !== card) return false; card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); return true; })()"
  if (-not (Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression $enterExpression)) {
    throw 'Isolated project card could not be activated from its real keyboard handler.'
  }
}

function Wait-RecoveryNoticeReady {
  param([object]$Target)
  # DOM contract: aria-live="polite" remains mounted for pending/export/error announcements.
  $expression = '(() => { const section = document.querySelector(''main section''); const live = section?.querySelector(''[aria-live="polite"]''); const recover = section?.querySelector(''svg.lucide-wrench'')?.closest(''button''); if (!section || !live || !recover || recover.disabled) return false; section.dataset.mythpenRecoveryNotice = ''true''; return true; })()'
  Wait-CdpExpressionTrue -Target $Target -Expression $expression -FailureMessage 'RecoveryNotice did not render its recoverable state and polite live region.'
}

function Invoke-RecoveryNoticeButton {
  param([object]$Target, [string]$IconClass)
  $expression = "(() => { const section = document.querySelector('main section'); const button = section?.querySelector('svg.$IconClass')?.closest('button'); if (!button || button.disabled) return false; button.click(); return true; })()"
  if (-not (Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression $expression)) {
    throw "RecoveryNotice action was unavailable: $IconClass"
  }
}

function Invoke-RecoveryNoticeBack {
  param([object]$Target)
  $expression = "(() => { const section = document.querySelector('main section'); const buttons = Array.from(section?.querySelectorAll('button') || []); const button = buttons.at(-1); if (!button) return false; button.click(); return true; })()"
  if (-not (Invoke-CdpExpression -WebSocketUrl $Target.webSocketDebuggerUrl -Expression $expression)) {
    throw 'RecoveryNotice back action was unavailable.'
  }
}

function Invoke-RecoveryNoticeMatrix {
  param([string]$Executable, [hashtable]$Expected)
  $scene = New-SmokeEnvironment -Label 'desktop-recovery-notice'
  $fixture = Invoke-RecoveryNoticeSceneSeeder -Environment $scene.Environment
  $desktop = Start-DebugDesktop -Executable $Executable -Environment $scene.Environment -SceneRoot $scene.Root
  $session = Wait-DesktopSession -Target $desktop.Target -Expected $Expected
  if ([int]$session.childPid -ne $desktop.OwnedChild.Id) {
    throw 'RecoveryNotice session childPid did not match the retained desktop-owned sidecar.'
  }
  Initialize-RecoveryNoticeRequestProbe -Target $desktop.Target -Session $session

  Enter-RecoveryProjectByKeyboard -Target $desktop.Target -ProjectName ([string]$fixture.projectName)
  Wait-RecoveryNoticeReady -Target $desktop.Target

  if (-not (Invoke-CdpExpression -WebSocketUrl $desktop.Target.webSocketDebuggerUrl -Expression 'globalThis.__mythpenDelayNextDiagnostics = true; true')) {
    throw 'Unable to arm the delayed RecoveryNotice refresh.'
  }
  Invoke-RecoveryNoticeButton -Target $desktop.Target -IconClass 'lucide-refresh-cw'
  Wait-CdpExpressionTrue -Target $desktop.Target -Expression 'document.querySelector(''[aria-live="polite"]'')?.textContent.trim().length > 0' -FailureMessage 'RecoveryNotice did not announce its pending refresh.'
  Invoke-RecoveryNoticeBack -Target $desktop.Target
  $projectJson = ([string]$fixture.projectName | ConvertTo-Json -Compress)
  $listExpression = "(() => !document.querySelector('[data-mythpen-recovery-notice=true]') && Array.from(document.querySelectorAll('[role=button]')).some((element) => String(element.textContent).includes($projectJson)))()"
  Wait-CdpExpressionTrue -Target $desktop.Target -Expression $listExpression -FailureMessage 'RecoveryNotice back action did not return to the real project list.'
  Start-Sleep -Milliseconds 1000
  if (-not (Invoke-CdpExpression -WebSocketUrl $desktop.Target.webSocketDebuggerUrl -Expression $listExpression)) {
    throw 'A late refresh response re-entered RecoveryNotice after cancellation.'
  }

  Enter-RecoveryProjectByKeyboard -Target $desktop.Target -ProjectName ([string]$fixture.projectName)
  Wait-RecoveryNoticeReady -Target $desktop.Target
  $writer = Start-RecoveryWriterHold -Environment $scene.Environment -LockRoot ([string]$fixture.lockRoot) -ProjectPath ([string]$fixture.projectPath)
  Invoke-RecoveryNoticeButton -Target $desktop.Target -IconClass 'lucide-wrench'
  $busyExpression = "(() => globalThis.__mythpenRecoveryRequests.some((entry) => entry.method === 'POST' && entry.url.endsWith('/diagnostics/recover') && entry.status === 423) && Boolean(document.querySelector('[role=alert]')?.textContent.trim()))()"
  Wait-CdpExpressionTrue -Target $desktop.Target -Expression $busyExpression -FailureMessage 'RecoveryNotice did not render the real PROJECT_WRITE_BUSY response.'
  Stop-RecoveryWriterHold -Process $writer

  $diagnosticsCount = [int](Invoke-CdpExpression -WebSocketUrl $desktop.Target.webSocketDebuggerUrl -Expression "globalThis.__mythpenRecoveryRequests.filter((entry) => entry.method === 'GET' && entry.url.endsWith('/diagnostics') && entry.status === 200).length")
  Invoke-RecoveryNoticeButton -Target $desktop.Target -IconClass 'lucide-refresh-cw'
  Wait-CdpExpressionTrue -Target $desktop.Target -Expression "globalThis.__mythpenRecoveryRequests.filter((entry) => entry.method === 'GET' && entry.url.endsWith('/diagnostics') && entry.status === 200).length > $diagnosticsCount" -FailureMessage 'RecoveryNotice refresh did not complete through the real diagnostics endpoint.'

  Invoke-RecoveryNoticeButton -Target $desktop.Target -IconClass 'lucide-download'
  $exportExpression = '(() => globalThis.__mythpenRecoveryRequests.some((entry) => entry.method === ''POST'' && entry.url.endsWith(''/diagnostics/export'') && entry.status === 200) && document.querySelector(''[aria-live="polite"]'')?.textContent.includes(''.mythpen-diagnostics.json''))()'
  Wait-CdpExpressionTrue -Target $desktop.Target -Expression $exportExpression -FailureMessage 'RecoveryNotice export did not publish its opaque filename in the live region.'
  $exports = @(Get-ChildItem -LiteralPath $scene.Exports -Filter '*.mythpen-diagnostics.json' -File)
  if ($exports.Count -ne 1) { throw 'RecoveryNotice export did not create exactly one diagnostics artifact.' }

  $successfulRecoveries = [int](Invoke-CdpExpression -WebSocketUrl $desktop.Target.webSocketDebuggerUrl -Expression "globalThis.__mythpenRecoveryRequests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/diagnostics/recover') && entry.status === 200).length")
  Invoke-RecoveryNoticeButton -Target $desktop.Target -IconClass 'lucide-wrench'
  $recoveredExpression = "(() => globalThis.__mythpenRecoveryRequests.filter((entry) => entry.method === 'POST' && entry.url.endsWith('/diagnostics/recover') && entry.status === 200).length > $successfulRecoveries && !document.querySelector('[data-mythpen-recovery-notice=true]'))()"
  Wait-CdpExpressionTrue -Target $desktop.Target -Expression $recoveredExpression -FailureMessage 'RecoveryNotice did not enter the ready project after both post-recovery checks.'

  $authenticatedExpression = "(() => { const requests = globalThis.__mythpenRecoveryRequests.filter((entry) => entry.url.startsWith('http://127.0.0.1:') && entry.url.includes('/api/')); return requests.length >= 8 && requests.every((entry) => entry.nonce === globalThis.__mythpenRecoveryExpectedNonce); })()"
  if (-not (Invoke-CdpExpression -WebSocketUrl $desktop.Target.webSocketDebuggerUrl -Expression $authenticatedExpression)) {
    throw 'RecoveryNotice local API traffic did not remain bound to the authenticated nonce transport.'
  }

  [MythpenSmokeWindow]::Close($desktop.WindowHandle)
  if (-not $desktop.OwnedChild.WaitForExit($TimeoutSeconds * 1000)) { throw 'RecoveryNotice owned sidecar did not terminate cleanly.' }
  if (-not $desktop.Process.WaitForExit($TimeoutSeconds * 1000)) { throw 'RecoveryNotice desktop did not terminate cleanly.' }
  if ($desktop.OwnedChild.ExitCode -ne 0 -or $desktop.Process.ExitCode -ne 0) {
    throw 'RecoveryNotice desktop scene did not produce two clean exits.'
  }
  Add-SmokeResult 'recovery_notice_e2e' 'PASS' 'Real Tauri/WebView2 rendered the isolated card and RecoveryNotice; keyboard entry, polite live region, cancel with a late refresh, real PROJECT_WRITE_BUSY, refresh, opaque export, two-check recovery, and nonce-bound transport all passed.'
}

function Invoke-DesktopMatrix {
  param([string]$Executable, [string]$SentinelExecutable, [hashtable]$Expected)
  Invoke-RecoveryNoticeMatrix -Executable $Executable -Expected $Expected
  $scene = New-SmokeEnvironment -Label 'desktop-normal'
  $desktop = Start-DebugDesktop -Executable $Executable -Environment $scene.Environment -SceneRoot $scene.Root
  $session = Wait-DesktopSession -Target $desktop.Target -Expected $Expected
  if ([int]$session.childPid -ne $desktop.OwnedChild.Id) { throw 'Desktop session childPid did not match the retained pre-handshake owned sidecar handle.' }
  $ownedSidecar = $desktop.OwnedChild
  if ((Get-HttpStatus -Port ([int]$session.port) -Nonce ('f' * 64)) -ne 401) { throw 'Desktop sidecar accepted a wrong nonce.' }
  $ownerWindowHandle = $desktop.WindowHandle
  if ($ownerWindowHandle -eq [IntPtr]::Zero) { throw 'Unable to identify the owner desktop main window.' }
  [MythpenSmokeWindow]::Minimize($ownerWindowHandle)
  $windowStateDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while (-not [MythpenSmokeWindow]::IsIconic($ownerWindowHandle) -and [DateTime]::UtcNow -lt $windowStateDeadline) {
    Start-Sleep -Milliseconds 25
  }
  if (-not [MythpenSmokeWindow]::IsIconic($ownerWindowHandle)) { throw 'Unable to minimize the owner before the second-instance callback.' }
  [MythpenSmokeWindow]::Hide($ownerWindowHandle)
  $windowStateDeadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([MythpenSmokeWindow]::IsWindowVisible($ownerWindowHandle) -and [DateTime]::UtcNow -lt $windowStateDeadline) {
    Start-Sleep -Milliseconds 25
  }
  if ([MythpenSmokeWindow]::IsWindowVisible($ownerWindowHandle)) { throw 'Unable to hide the minimized owner before the second-instance callback.' }
  $secondScene = New-SmokeEnvironment -Label 'desktop-second'
  $secondInstanceRootBefore = Get-TreeDigest -Paths @($secondScene.Root)
  $second = New-ChildProcess -Executable $Executable -Environment $secondScene.Environment
  $ownerChildSamples = 0
  $ownerVisibleObserved = $false
  $ownerUnminimizedObserved = $false
  $ownerForegroundObserved = $false
  $secondDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $ownerChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($desktop.Process.Id)" | Where-Object { $_.Name -like 'mythpen-server*' })
    $secondChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($second.Id)" | Where-Object { $_.Name -like 'mythpen-server*' })
    if ($ownerChildren.Count -ne 1 -or [int]$ownerChildren[0].ProcessId -ne [int]$session.childPid) {
      throw 'Second instance changed the owner sidecar cardinality during sampled execution.'
    }
    if ($secondChildren.Count -ne 0) { throw 'Second instance briefly spawned its own sidecar child.' }
    if ([MythpenSmokeWindow]::IsWindowVisible($ownerWindowHandle)) { $ownerVisibleObserved = $true }
    if (-not [MythpenSmokeWindow]::IsIconic($ownerWindowHandle)) { $ownerUnminimizedObserved = $true }
    if ([MythpenSmokeWindow]::GetForegroundWindow() -eq $ownerWindowHandle) { $ownerForegroundObserved = $true }
    $ownerChildSamples += 1
    if ($second.HasExited) { break }
    Start-Sleep -Milliseconds 25
  } while ([DateTime]::UtcNow -lt $secondDeadline)
  if (-not $second.HasExited) { throw 'Second desktop instance did not exit after handing focus to the owner.' }
  if ($second.ExitCode -ne 0) { throw 'Second desktop instance did not exit cleanly.' }
  $windowStateDeadline = [DateTime]::UtcNow.AddSeconds(3)
  while (
    (-not $ownerVisibleObserved -or -not $ownerUnminimizedObserved -or -not $ownerForegroundObserved) -and
    [DateTime]::UtcNow -lt $windowStateDeadline
  ) {
    if ([MythpenSmokeWindow]::IsWindowVisible($ownerWindowHandle)) { $ownerVisibleObserved = $true }
    if (-not [MythpenSmokeWindow]::IsIconic($ownerWindowHandle)) { $ownerUnminimizedObserved = $true }
    if ([MythpenSmokeWindow]::GetForegroundWindow() -eq $ownerWindowHandle) { $ownerForegroundObserved = $true }
    Start-Sleep -Milliseconds 25
  }
  if (-not $ownerVisibleObserved -or -not $ownerUnminimizedObserved -or -not $ownerForegroundObserved) {
    throw 'Second-instance callback did not show, unminimize, and focus the owner window.'
  }
  $secondInstanceRootAfter = Get-TreeDigest -Paths @($secondScene.Root)
  if ($secondInstanceRootBefore -ne $secondInstanceRootAfter) { throw 'Second instance modified its isolated data/control/WebView2 root.' }
  Add-SmokeResult 'second_instance' 'PASS' "Second desktop showed, unminimized, and focused the owner, exited cleanly with an unchanged isolated root; $ownerChildSamples short-interval samples retained exactly one owner sidecar and none under the second process."
  Add-SmokeResult 'desktop_session' 'PASS' 'Debug desktop published an authenticated dynamic session with off/full commit/triple.'
  [MythpenSmokeWindow]::Close($desktop.WindowHandle)
  if (-not $ownedSidecar.WaitForExit($TimeoutSeconds * 1000)) { throw 'Owned sidecar did not terminate during normal desktop shutdown.' }
  if (-not $desktop.Process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Desktop did not exit after clean owned-child termination.' }
  if ($ownedSidecar.ExitCode -ne 0 -or $desktop.Process.ExitCode -ne 0) { throw 'Normal desktop shutdown did not produce two clean process exits.' }
  if ($ownedSidecar.ExitTime -gt $desktop.Process.ExitTime) { throw 'Desktop exited before its owned sidecar terminated.' }
  Add-SmokeResult 'desktop_normal_shutdown' 'PASS' 'Window close observed the owned sidecar exit cleanly before the desktop, with exit code 0 for both processes.'

  $sentinelScene = New-SmokeEnvironment -Label 'desktop-sentinel'
  $sentinel = Start-OwnedSidecar -Executable $SentinelExecutable -Environment $sentinelScene.Environment -Nonce (New-RandomHex) -Expected $Expected
  if ((Get-HttpStatus -Port ([int]$sentinel.Ready.port) -Nonce $sentinel.Nonce) -ne 200) { throw 'Independent sentinel sidecar was not healthy before emergency testing.' }

  $emergencyScene = New-SmokeEnvironment -Label 'desktop-emergency'
  $faultArmPath = Join-Path $emergencyScene.Root 'shutdown-close-fault.arm'
  $faultMap = @{
    'atomicstore.close.before-database-close' = @{
      throw = 'SMOKE_CLOSE_FAILURE'
      whenFileExists = $faultArmPath
    }
  } | ConvertTo-Json -Compress -Depth 4
  $emergency = Start-DebugDesktop -Executable $Executable -Environment $emergencyScene.Environment -SceneRoot $emergencyScene.Root -FaultMap $faultMap
  $emergencySession = Wait-DesktopSession -Target $emergency.Target -Expected $Expected
  if ([int]$emergencySession.childPid -ne $emergency.OwnedChild.Id) { throw 'Emergency session childPid did not match the retained pre-handshake owned sidecar handle.' }
  $emergencySidecar = $emergency.OwnedChild
  Wait-CdpExpressionTrue -Target $emergency.Target -Expression "document.querySelector('#root')?.childElementCount > 0" -FailureMessage 'Emergency desktop React UI did not mount.'
  $faultArm = [System.IO.File]::Open(
    $faultArmPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $faultArm.WriteByte(1)
    $faultArm.Flush($true)
  } finally {
    $faultArm.Dispose()
  }
  [MythpenSmokeWindow]::Close($emergency.WindowHandle)
  Wait-CdpDialogButtonCount -Target $emergency.Target -ExpectedCount 1
  Start-Sleep -Milliseconds 300
  if ($emergency.Process.HasExited -or $emergencySidecar.HasExited) { throw 'Failed shutdown did not preserve the app and owned child for an explicit emergency decision.' }
  Click-CdpDialogButton -Target $emergency.Target -ExpectedCount 1 -Index 0
  Wait-CdpEmergencyConfirmation -Target $emergency.Target
  Click-CdpDialogButton -Target $emergency.Target -ExpectedCount 2 -Index 1
  if (-not $emergencySidecar.WaitForExit($TimeoutSeconds * 1000)) { throw 'Emergency owned sidecar survived the confirmed emergency action.' }
  if (-not $emergency.Process.WaitForExit($TimeoutSeconds * 1000)) { throw 'Desktop did not exit after emergency owned-child termination.' }
  if ($emergencySidecar.ExitCode -eq 0) { throw 'Emergency owned child unexpectedly reported a clean exit.' }
  if ($emergency.Process.ExitCode -ne 0) { throw 'Desktop emergency path did not exit with its requested app status.' }
  if ($emergencySidecar.ExitTime -gt $emergency.Process.ExitTime) { throw 'Desktop emergency path exited before the owned child was terminated.' }
  if ((Get-HttpStatus -Port ([int]$sentinel.Ready.port) -Nonce $sentinel.Nonce) -ne 200) { throw 'Emergency exit affected the independent authenticated sentinel sidecar.' }
  Add-SmokeResult 'emergency_exit' 'PASS' 'A post-session marker armed the isolated close fault without affecting startup; the rendered two-step emergency confirmation then produced a non-clean owned-child exit before the clean desktop exit.'
  Add-SmokeResult 'sentinel_unowned_survived' 'PASS' 'The independent authenticated sentinel remained healthy after emergency killed the desktop-owned sidecar.'
  Stop-OwnedSidecarClean -Owned $sentinel
}

function Invoke-SelfTest {
  $scene = New-SmokeEnvironment -Label 'selftest'
  foreach ($value in @($scene.Profile, $scene.Data, $scene.Exports, $scene.WebView2)) {
    if (-not $value.StartsWith($scene.Root, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Smoke root escaped its temporary root.' }
  }
  $safeRoot = Assert-SmokeRootSafeForCleanup -Root $scene.Root
  if ($safeRoot -ne [System.IO.Path]::GetFullPath($scene.Root)) { throw 'Cleanup root canonicalization mismatch.' }
  $unsafeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('unsafe-' + [guid]::NewGuid().ToString('N'))
  $unsafeRejected = $false
  try { Assert-SmokeRootSafeForCleanup -Root $unsafeRoot | Out-Null } catch { $unsafeRejected = $true }
  if (-not $unsafeRejected) { throw 'Unsafe cleanup root was accepted.' }
  if (-not [MythpenSmokeWindow]::MatchesTauriMainWindowIdentity('Tauri Window', 'Mythpen', $true)) {
    throw 'The exact visible Tauri application window identity was rejected.'
  }
  foreach ($wrongIdentity in @(
    @('com.mythpen.desktop-sic', '-siw', $true),
    @('Tao Thread Event Target', '', $true),
    @('Tauri Window', 'Mythpen', $false)
  )) {
    if ([MythpenSmokeWindow]::MatchesTauriMainWindowIdentity($wrongIdentity[0], $wrongIdentity[1], [bool]$wrongIdentity[2])) {
      throw 'A helper, thread-target, or hidden window matched the Tauri application window identity.'
    }
  }
  $selfTestCdpLease = New-ControlledCdpPortLease
  try {
    $selfTestCdpEndpoint = [System.Net.IPEndPoint]$selfTestCdpLease.Listener.LocalEndpoint
    if ($selfTestCdpEndpoint.Address -ne [System.Net.IPAddress]::Loopback -or $selfTestCdpEndpoint.Port -ne $selfTestCdpLease.Port) {
      throw 'Controlled CDP port lease did not reserve its reported loopback endpoint.'
    }
  } finally {
    $selfTestCdpLease.Listener.Stop()
  }
  $selfTestRebind = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$selfTestCdpLease.Port)
  try {
    $selfTestRebind.Server.ExclusiveAddressUse = $true
    $selfTestRebind.Start()
  } finally {
    $selfTestRebind.Stop()
  }
  $selfTestNoListenerProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  try {
    if (Assert-CdpListenerOwnedByDesktopWebView -Port ([int]$selfTestCdpLease.Port) -WebView2Root $scene.WebView2 -DesktopProcess $selfTestNoListenerProcess) {
      throw 'A released CDP port was incorrectly reported as an owned WebView2 listener.'
    }
  } finally {
    $selfTestNoListenerProcess.Dispose()
  }
  $environmentProbe = [System.Diagnostics.ProcessStartInfo]::new()
  $environmentProbe.UseShellExecute = $false
  Set-ChildEnvironment -StartInfo $environmentProbe -Environment @{ MYTHPEN_SMOKE_ENV_PROBE = 'isolated' }
  if ([MythpenSmokeProcessEnvironment]::Get($environmentProbe, 'MYTHPEN_SMOKE_ENV_PROBE') -ne 'isolated') {
    throw 'ProcessStartInfo environment assignment is unavailable in this PowerShell runtime.'
  }
  $childEnvironmentProbe = [System.Diagnostics.ProcessStartInfo]::new()
  $childEnvironmentProbe.FileName = [Environment]::GetEnvironmentVariable('ComSpec')
  $childEnvironmentProbe.Arguments = '/d /c if "%MYTHPEN_SMOKE_CHILD_PROBE%"=="actual-child" (exit /b 0) else (exit /b 7)'
  $childEnvironmentProbe.UseShellExecute = $false
  $childEnvironmentProbe.CreateNoWindow = $true
  Set-ChildEnvironment -StartInfo $childEnvironmentProbe -Environment @{ MYTHPEN_SMOKE_CHILD_PROBE = 'actual-child' }
  $childEnvironmentProbeProcess = [System.Diagnostics.Process]::Start($childEnvironmentProbe)
  if (-not $childEnvironmentProbeProcess.WaitForExit(5000) -or $childEnvironmentProbeProcess.ExitCode -ne 0) {
    throw 'Normalized ProcessStartInfo environment did not reach an actual child process.'
  }
  $childEnvironmentProbeProcess.Dispose()
  $exitedProbeStart = [System.Diagnostics.ProcessStartInfo]::new()
  $exitedProbeStart.FileName = [Environment]::GetEnvironmentVariable('ComSpec')
  $exitedProbeStart.Arguments = '/d /c exit /b 0'
  $exitedProbeStart.UseShellExecute = $false
  $exitedProbeStart.CreateNoWindow = $true
  $exitedProbe = [System.Diagnostics.Process]::Start($exitedProbeStart)
  if (-not $exitedProbe.WaitForExit(5000)) { throw 'Unable to establish the exited-process CDP negative-test fixture.' }
  $aliveProbe = [System.Diagnostics.Process]::GetCurrentProcess()
  try {
    $parentExitRejected = $false
    try {
      Assert-DesktopProcessesReadyForCdp -DesktopProcess $exitedProbe -OwnedChild $aliveProbe
    } catch [MythpenSmokeDesktopCdpUnavailableException] {
      throw 'parent-exit-negative was incorrectly classified as environment NOT_RUN.'
    } catch {
      $parentExitRejected = $true
    }
    if (-not $parentExitRejected) { throw 'parent-exit-negative was not rejected as a product failure.' }
    $childExitRejected = $false
    try {
      Assert-DesktopProcessesReadyForCdp -DesktopProcess $aliveProbe -OwnedChild $exitedProbe
    } catch [MythpenSmokeDesktopCdpUnavailableException] {
      throw 'child-exit-negative was incorrectly classified as environment NOT_RUN.'
    } catch {
      $childExitRejected = $true
    }
    if (-not $childExitRejected) { throw 'child-exit-negative was not rejected as a product failure.' }
  } finally {
    $exitedProbe.Dispose()
    $aliveProbe.Dispose()
  }
  $drainProbe = New-ChildProcess -Executable ([Environment]::GetEnvironmentVariable('ComSpec')) -Arguments '/d /c "(echo stdout) & (echo stderr 1>&2)"' -Environment @{ MYTHPEN_SMOKE_DRAIN_PROBE = 'isolated' }
  if (-not $drainProbe.WaitForExit(5000) -or -not $drainProbe.StartInfo.RedirectStandardOutput -or -not $drainProbe.StartInfo.RedirectStandardError) {
    throw 'Non-control child output was not redirected and drained asynchronously.'
  }
  $preHandshakeBin = Join-Path $scene.Root 'prehandshake-cleanup'
  [System.IO.Directory]::CreateDirectory($preHandshakeBin) | Out-Null
  $preHandshakeDesktopExecutable = Join-Path $preHandshakeBin 'mythpen.exe'
  $preHandshakeSidecarExecutable = Join-Path $preHandshakeBin 'mythpen-server.exe'
  Copy-Item -LiteralPath ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) -Destination $preHandshakeDesktopExecutable
  Copy-Item -LiteralPath ([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) -Destination $preHandshakeSidecarExecutable
  $preHandshakeLaunchScript = Join-Path $preHandshakeBin 'launch-owned-child.ps1'
  $preHandshakeLaunchText = @(
    '$start = [System.Diagnostics.ProcessStartInfo]::new()'
    '$start.FileName = Join-Path $PSScriptRoot ''mythpen-server.exe'''
    '$start.Arguments = ''-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 10"'''
    '$start.UseShellExecute = $false'
    '$child = [System.Diagnostics.Process]::new()'
    '$child.StartInfo = $start'
    'if (-not $child.Start()) { exit 9 }'
    'Start-Sleep -Seconds 10'
  ) -join "`r`n"
  [System.IO.File]::WriteAllText(
    $preHandshakeLaunchScript,
    $preHandshakeLaunchText,
    [System.Text.UTF8Encoding]::new($false)
  )
  $preHandshakeDesktop = New-ChildProcess -Executable $preHandshakeDesktopExecutable -Arguments "-NoProfile -NonInteractive -File `"$preHandshakeLaunchScript`"" -Environment @{
    MYTHPEN_SMOKE_PREHANDSHAKE_PROBE = 'isolated'
  }
  $preHandshakeOwnedChild = Wait-RegisterDesktopOwnedChildBeforeSession -DesktopProcess $preHandshakeDesktop -DesktopExecutable $preHandshakeDesktopExecutable
  if ($preHandshakeOwnedChild.Handle -eq [IntPtr]::Zero -or $preHandshakeOwnedChild.Id -eq $preHandshakeDesktop.Id) {
    throw 'Pre-handshake cleanup did not retain the exact direct owned-child process handle.'
  }
  $selfParent = [System.Diagnostics.Process]::GetCurrentProcess()
  $selfStart = [System.Diagnostics.ProcessStartInfo]::new()
  $selfStart.FileName = $selfParent.MainModule.FileName
  $selfStart.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 10"'
  $selfStart.UseShellExecute = $false
  $selfStart.CreateNoWindow = $true
  $selfChild = [System.Diagnostics.Process]::new()
  $selfChild.StartInfo = $selfStart
  if (-not $selfChild.Start()) { throw 'Unable to start the retained-process self-test child.' }
  try {
    $retainedChild = Register-OwnedProcessObject -ParentProcess $selfParent -ChildPid $selfChild.Id -ExpectedNamePrefix $selfChild.ProcessName
    if ($retainedChild.Handle -eq [IntPtr]::Zero) { throw 'Retained child process handle was invalid.' }
    $retainedChild.Kill()
    if (-not $retainedChild.WaitForExit(5000)) { throw 'Retained self-test child did not exit.' }
  } finally {
    try { if (-not $selfChild.HasExited) { $selfChild.Kill() } } catch { }
    try { $selfChild.Dispose() } catch { }
    try { $selfParent.Dispose() } catch { }
  }
  Add-SmokeResult 'self_test' 'PASS' 'Temporary roots are isolated, result states are explicit, and child cleanup retains a verified process handle.'
  foreach ($name in @('fake3001', 'ready_build_info', 'runtime_mode_bypass', 'wrong_nonce', 'cross_instance_nonce', 'normal_shutdown', 'continue_wait', 'cancel_shutdown', 'slow_drain_cancel', 'closing_cancel_rejected')) {
    Add-SmokeResult $name 'NOT_RUN' 'SelfTest validates harness structure only; no compiled product was started.'
  }
  $policyEvidence = Get-RemoteDebuggingPolicyEvidence
  if ($policyEvidence -notmatch 'HKCU Edge=' -or $policyEvidence -notmatch 'HKLM Edge/WebView2=') {
    throw 'SelfTest could not capture all read-only remote-debugging policy locations.'
  }
  $defaultSnapshotFinallyRegression = Get-DefaultUserStateSnapshot
  if (@(Compare-DefaultUserStateSnapshots -Before $defaultSnapshotFinallyRegression -After $defaultSnapshotFinallyRegression).Count -ne 0) {
    throw 'default-snapshot-finally-regression reported a change for an identical snapshot.'
  }
  $changedSnapshotProbe = [ordered]@{}
  foreach ($label in $defaultSnapshotFinallyRegression.Keys) { $changedSnapshotProbe[$label] = $defaultSnapshotFinallyRegression[$label] }
  $changedSnapshotProbe.control = 'self-test-forced-difference'
  $changedSnapshotLabels = @(Compare-DefaultUserStateSnapshots -Before $defaultSnapshotFinallyRegression -After $changedSnapshotProbe)
  if ($changedSnapshotLabels.Count -ne 1 -or $changedSnapshotLabels[0] -ne 'control') {
    throw 'default-snapshot-finally-regression did not identify the exact changed component label.'
  }
  Add-DesktopNotRunResults -Reason 'SelfTest validates harness structure only; no compiled desktop product was started.'
}

$primaryError = $null
$defaultStateBefore = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
try {
  if ($Mode -eq 'SelfTest') {
    Invoke-SelfTest
  } else {
    $defaultStateBefore = Get-DefaultUserStateSnapshot
    $expected = Get-ExpectedBuildInfo
    if ($Mode -in @('All', 'Sidecar')) {
      $resolvedSidecar = Resolve-SidecarPath -RequestedPath $SidecarPath -TargetTriple $expected.TargetTriple
      Invoke-SidecarMatrix -Executable $resolvedSidecar -Expected $expected
    }
    if ($Mode -in @('All', 'Desktop')) {
      $resolvedDesktop = Resolve-DesktopPath -RequestedPath $DesktopPath
      $resolvedDesktopSentinel = Resolve-SidecarPath -RequestedPath $SidecarPath -TargetTriple $expected.TargetTriple
      try {
        Invoke-DesktopMatrix -Executable $resolvedDesktop -SentinelExecutable $resolvedDesktopSentinel -Expected $expected
      } catch [MythpenSmokeDesktopCdpUnavailableException] {
        $policyEvidence = Get-RemoteDebuggingPolicyEvidence
        $reason = "Desktop CDP automation unavailable: $([string]$_.Exception.Message) Read-only RemoteDebuggingAllowed policy evidence: $policyEvidence. The compiled Desktop product matrix could not run past its CDP readiness boundary."
        Add-DesktopNotRunResults -Reason $reason
      }
    }
  }
} catch {
  $primaryError = $_
  [Console]::Error.WriteLine("MYTHPEN_DESKTOP_LIFECYCLE_SMOKE_PRIMARY_ERROR $([string]$_.Exception.Message)")
  Add-SmokeResult 'harness' 'FAIL' ("$([string]$_.Exception.Message) $($_.ScriptStackTrace)".Trim())
} finally {
  if ($script:FakePortListener) {
    try { $script:FakePortListener.Stop() } catch {
      $cleanupFailures.Add('Unable to stop the fake port listener.')
      if (-not $primaryError) { $primaryError = $_ }
    }
  }
  foreach ($process in $script:Processes) {
    try {
      if (-not $process.HasExited) { $process.Kill() }
      if (-not $process.WaitForExit(5000)) { throw 'Exact retained smoke process did not exit after cleanup.' }
    } catch {
      $cleanupFailures.Add('Unable to terminate an exact retained smoke process.')
      if (-not $primaryError) { $primaryError = $_ }
    }
    try { $process.Dispose() } catch {
      $cleanupFailures.Add('Unable to dispose an exact retained smoke process handle.')
      if (-not $primaryError) { $primaryError = $_ }
    }
  }
  if ($Mode -ne 'SelfTest' -and $defaultStateBefore) {
    try {
      $defaultStateAfter = Get-DefaultUserStateSnapshot
      $changedDefaultStateLabels = @(Compare-DefaultUserStateSnapshots -Before $defaultStateBefore -After $defaultStateAfter)
      if ($changedDefaultStateLabels.Count -eq 0) {
        Add-SmokeResult 'default_user_roots_unchanged' 'PASS' 'Default data/control/WebView2 trees and path-store registry digest were unchanged.'
      } else {
        Add-SmokeResult 'default_user_roots_unchanged' 'FAIL' ("Default user-state components changed: {0}." -f ($changedDefaultStateLabels -join ', '))
        if (-not $primaryError) {
          $primaryError = [System.InvalidOperationException]::new('Default user-state changed during isolated smoke.')
        }
      }
    } catch {
      Add-SmokeResult 'default_user_roots_unchanged' 'FAIL' 'Default user data/control/WebView2 state changed or could not be verified.'
      if (-not $primaryError) { $primaryError = $_ }
    }
  }
  if (-not $KeepArtifacts) {
    foreach ($root in $script:SmokeRoots) {
      try {
        $safeRoot = Assert-SmokeRootSafeForCleanup -Root $root
        Remove-Item -LiteralPath $safeRoot -Recurse -Force
      } catch {
        $cleanupFailures.Add('Unable to remove an exact validated smoke temp root.')
        if (-not $primaryError) { $primaryError = $_ }
      }
    }
  }
  if ($cleanupFailures.Count -gt 0) {
    Add-SmokeResult 'cleanup' 'FAIL' ($cleanupFailures -join ' ')
  }
}

$summary = [ordered]@{
  format = 'MYTHPEN_DESKTOP_LIFECYCLE_SMOKE'
  mode = $Mode
  results = $script:Results
}
Write-Output ("MYTHPEN_DESKTOP_LIFECYCLE_SMOKE {0}" -f ($summary | ConvertTo-Json -Compress -Depth 8))
if ($primaryError -or @($script:Results | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { exit 1 }
