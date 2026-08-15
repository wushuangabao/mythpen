import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildWindowsNativeDirectoryProbe, buildWindowsNativeRollbackProbe } from './build-sidecars.mjs'
import rollbackCapability from '../server/platform/windows-native-rollback-capability.js'
import directoryCapability from '../server/platform/windows-native-directory-capability.js'

const { WINDOWS_ROLLBACK_CRASH_CASES } = rollbackCapability
const { WINDOWS_DIRECTORY_ENTRY_CRASH_CASES } = directoryCapability

const EXTERNAL_ROOT = 'D:\\Mythpen\\l1-vm'
const VM_NAME = 'Mythpen-L1-Win10-LTSC2021'
const BASELINE_SNAPSHOT = 'mythpen-l1-baseline-v1'
const ROLLBACK_EVIDENCE_DIRECTORY = join(EXTERNAL_ROOT, 'evidence', 'rollback-journal')
const DIRECTORY_EVIDENCE_DIRECTORY = join(EXTERNAL_ROOT, 'evidence', 'application-directory')
const ROOT_PREFIX = 'mythpen-native-rollback-vm-'
const DIRECTORY_ROOT_PREFIX = 'mythpen-native-directory-vm-'
const CONTROL_PREFIX = 'mythpen-native-rollback-control-'

export const VM_SPEC = Object.freeze({
  name: VM_NAME,
  vmDirectory: join(EXTERNAL_ROOT, 'VirtualBox', VM_NAME),
  vboxManagePath: 'D:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe',
  guestAdditionsIsoPath: 'D:\\Program Files\\Oracle\\VirtualBox\\VBoxGuestAdditions.iso',
  isoPath: join(
    EXTERNAL_ROOT,
    'downloads',
    'Windows10EnterpriseLTSC2021Eval-x64-zh-cn.iso',
  ),
  isoSize: 5_043_298_304,
  isoSha256: '2181EAAEED2F1A78BE41F45692671DB050D9FF76291F767AB696147C8A322DA3',
  credentialPath: join(EXTERNAL_ROOT, 'secrets', 'guest-credentials.json'),
  evidenceDirectory: join(EXTERNAL_ROOT, 'evidence', 'environment'),
  diskPath: join(EXTERNAL_ROOT, 'VirtualBox', VM_NAME, `${VM_NAME}.vdi`),
  baseDiskUuid: '60a78c82-ddda-4cd0-9010-b284dfa25b5b',
  baselineSnapshot: BASELINE_SNAPSHOT,
  osType: 'Windows10_64',
  cpus: 2,
  memoryMiB: 4096,
  diskSizeMiB: 64 * 1024,
  storage: Object.freeze({ name: 'SATA', controller: 'IntelAhci', hostIoCache: 'off' }),
  network: Object.freeze({ nic1: 'nat', otherNics: 'none' }),
  sharedDataRoot: null,
  guestDataRoot: 'C:\\Mythpen-L1-TestData',
  guestDirectoryRoot: 'C:\\MythpenProbe\\runs',
  rollbackEvidenceDirectory: ROLLBACK_EVIDENCE_DIRECTORY,
  directoryEvidenceDirectory: DIRECTORY_EVIDENCE_DIRECTORY,
})

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4))

function sleep(milliseconds) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, milliseconds)
}

function command(args) {
  return { executable: VM_SPEC.vboxManagePath, args }
}

export function buildCreateCommandPlan() {
  return [
    command([
      'createvm',
      '--name', VM_SPEC.name,
      '--ostype', VM_SPEC.osType,
      '--basefolder', dirname(VM_SPEC.vmDirectory),
      '--register',
    ]),
    command([
      'modifyvm', VM_SPEC.name,
      '--cpus', String(VM_SPEC.cpus),
      '--memory', String(VM_SPEC.memoryMiB),
      '--vram', '128',
      '--ioapic', 'on',
      '--boot1', 'dvd',
      '--boot2', 'disk',
      '--boot3', 'none',
      '--boot4', 'none',
      '--nic1', VM_SPEC.network.nic1,
      '--nic2', VM_SPEC.network.otherNics,
      '--nic3', VM_SPEC.network.otherNics,
      '--nic4', VM_SPEC.network.otherNics,
      '--nic5', VM_SPEC.network.otherNics,
      '--nic6', VM_SPEC.network.otherNics,
      '--nic7', VM_SPEC.network.otherNics,
      '--nic8', VM_SPEC.network.otherNics,
      '--clipboard-mode', 'disabled',
      '--draganddrop', 'disabled',
      '--audio', 'none',
      '--usb', 'off',
    ]),
    command([
      'storagectl', VM_SPEC.name,
      '--name', VM_SPEC.storage.name,
      '--add', 'sata',
      '--controller', VM_SPEC.storage.controller,
      '--portcount', '2',
      '--bootable', 'on',
      '--hostiocache', VM_SPEC.storage.hostIoCache,
    ]),
    command([
      'createmedium', 'disk',
      '--filename', VM_SPEC.diskPath,
      '--size', String(VM_SPEC.diskSizeMiB),
      '--format', 'VDI',
      '--variant', 'Standard',
    ]),
    command([
      'storageattach', VM_SPEC.name,
      '--storagectl', VM_SPEC.storage.name,
      '--port', '0',
      '--device', '0',
      '--type', 'hdd',
      '--medium', VM_SPEC.diskPath,
    ]),
  ]
}

function redact(value, secrets = []) {
  let safe = String(value ?? '')
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[REDACTED]')
  }
  return safe
}

function run(executable, args, options = {}) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('External commands require a string argument array')
  }
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    input: options.input,
  })
  if (result.error && !options.allowFailure) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const details = redact(result.stderr || result.stdout || `exit ${result.status}`, options.secrets)
    throw new Error(`${basename(executable)} ${args[0]} failed: ${details.trim()}`)
  }
  return result
}

function runVBox(args, options = {}) {
  return run(VM_SPEC.vboxManagePath, args, options)
}

export function parseMachineReadable(output) {
  const values = {}
  for (const line of output.split(/\r?\n/)) {
    if (line === '') continue
    if (/^ rec_screen(?:0|[1-9][0-9]*)$/.test(line)) continue
    if (/^VideoMode="[1-9][0-9]{0,4},[1-9][0-9]{0,4},(?:8|16|24|32)"@-?(?:0|[1-9][0-9]*),-?(?:0|[1-9][0-9]*) [01]$/.test(line)) continue
    if (/^VRDEClients==(?:0|[1-9][0-9]*)$/.test(line)) continue
    if (/^GuestAdditionsFacility_(?:VirtualBox Base Driver|VirtualBox System Service|VirtualBox Desktop Integration|Seamless Mode|Graphics Mode)=(?:0|[1-9][0-9]*),(?:0|[1-9][0-9]*)$/.test(line)) continue
    const match = /^(?:"([A-Za-z0-9_.:-]+)"|([A-Za-z0-9_.:-]+))=(?:"([^"]*)"|([^"\s=]+))$/.exec(line)
    if (!match) throw new Error(`Invalid VirtualBox machine-readable line: ${line}`)
    const key = match[1] ?? match[2]
    if (Object.hasOwn(values, key)) {
      throw new Error(`Duplicate VirtualBox machine-readable key: ${key}`)
    }
    let value = match[3] ?? match[4]
    if (match[3] !== undefined) {
      const runLengths = [...value.matchAll(/\\+/g)].map((run) => run[0].length)
      if (runLengths.some((length) => length > 2) || (
        runLengths.includes(1) && runLengths.includes(2)
      )) {
        throw new Error(`Ambiguous VirtualBox machine-readable value for ${key}`)
      }
      if (runLengths.includes(2)) value = value.replaceAll('\\\\', '\\')
    }
    values[key] = value
  }
  return values
}

function normalizedPath(value) {
  return resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

function readExactCfgFile(machine) {
  const expected = join(VM_SPEC.vmDirectory, `${VM_SPEC.name}.vbox`)
  if (normalizedPath(machine.CfgFile ?? '') !== normalizedPath(expected)) {
    throw new Error(`Refusing unexpected CfgFile: ${machine.CfgFile}`)
  }
  const metadata = lstatSync(expected)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Refusing CfgFile that is not an ordinary file')
  }
  if (normalizedPath(realpathSync.native(expected)) !== normalizedPath(expected)) {
    throw new Error('Refusing an indirectly resolved CfgFile')
  }
  return readFileSync(expected, 'utf8')
}

export function validateWindowsOsTypeEvidence({ configXml, ostypes, showVmInfoOsType }) {
  const configuredIds = [...configXml.matchAll(/<Machine\b[^>]*\bOSType="([^"]+)"/g)]
    .map((match) => match[1])
  if (configuredIds.length !== 1 || configuredIds[0] !== VM_SPEC.osType) {
    throw new Error('OS type internal configuration ID is not exactly Windows10_64')
  }

  const matchingEntries = ostypes.split(/\r?\n\s*\r?\n/).filter((entry) => (
    (
      /^ID:\s*Windows10_64\s*$/m.test(entry)
      && /^Description:\s*Windows 10 \(64-bit\)\s*$/m.test(entry)
    )
    || /^ID \/ Description:\s*Windows10_64 -- Windows 10 \(64-bit\)\s*$/m.test(entry)
  ))
  if (matchingEntries.length !== 1) {
    throw new Error('OS type ID/display mapping is not exact')
  }
  if (showVmInfoOsType !== 'Windows 10 (64-bit)') {
    throw new Error('OS type display value is not exactly Windows 10 (64-bit)')
  }
  return { id: VM_SPEC.osType, display: showVmInfoOsType }
}

function assertExactTarget(machine) {
  if (machine.name !== VM_SPEC.name) throw new Error('Refusing non-exact VM name')
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(machine.UUID ?? '')) {
    throw new Error('Refusing VM without an exact UUID')
  }
  if (!isAbsolute(machine.CfgFile ?? '')) throw new Error('Refusing VM without an absolute CfgFile')
  if (normalizedPath(dirname(machine.CfgFile)) !== normalizedPath(VM_SPEC.vmDirectory)) {
    throw new Error(`Refusing VM outside ${VM_SPEC.vmDirectory}`)
  }
}

function registeredMachines() {
  const result = runVBox(['list', 'vms'])
  return result.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^"(.*)" \{([0-9a-f-]+)\}$/i.exec(line.trim())
    return match ? [{ name: match[1], uuid: match[2] }] : []
  })
}

function exactMachine({ required = true } = {}) {
  const listed = registeredMachines().filter(({ name }) => name === VM_SPEC.name)
  if (listed.length === 0) {
    if (required) throw new Error(`VM is not registered: ${VM_SPEC.name}`)
    return null
  }
  if (listed.length !== 1) throw new Error('Refusing ambiguous target VM registration')
  const result = runVBox(['showvminfo', listed[0].uuid, '--machinereadable'])
  const machine = parseMachineReadable(result.stdout)
  assertExactTarget(machine)
  if (machine.UUID.toLowerCase() !== listed[0].uuid.toLowerCase()) {
    throw new Error('Refusing mismatched registered VM UUID')
  }
  return machine
}

function sha256(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  const descriptor = openSync(path, 'r')
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
    return hash.digest('hex').toUpperCase()
  } finally {
    closeSync(descriptor)
  }
}

function inspectIso() {
  if (!existsSync(VM_SPEC.isoPath)) throw new Error(`Required ISO missing: ${VM_SPEC.isoPath}`)
  const size = statSync(VM_SPEC.isoPath).size
  if (size !== VM_SPEC.isoSize) throw new Error(`ISO size mismatch: ${size}`)
  const digest = sha256(VM_SPEC.isoPath)
  if (digest !== VM_SPEC.isoSha256) throw new Error(`ISO SHA-256 mismatch: ${digest}`)
  return { path: VM_SPEC.isoPath, size, sha256: digest }
}

function assertIsolatedConfiguration(machine) {
  assertExactTarget(machine)
  validateWindowsOsTypeEvidence({
    configXml: readExactCfgFile(machine),
    ostypes: runVBox(['list', 'ostypes']).stdout,
    showVmInfoOsType: machine.ostype,
  })
  const expected = [
    ['cpus', String(VM_SPEC.cpus)],
    ['memory', String(VM_SPEC.memoryMiB)],
    ['nic1', 'nat'],
    ['nic2', 'none'],
    ['nic3', 'none'],
    ['nic4', 'none'],
    ['nic5', 'none'],
    ['nic6', 'none'],
    ['nic7', 'none'],
    ['nic8', 'none'],
    ['clipboard', 'disabled'],
    ['draganddrop', 'disabled'],
    ['storagecontrollertype0', 'IntelAhci'],
  ]
  for (const [key, value] of expected) {
    if (machine[key] !== value) throw new Error(`Unsafe VM configuration: ${key}=${machine[key]}`)
  }
  if (Object.keys(machine).some((key) => /SharedFolder|Forwarding/i.test(key))) {
    throw new Error('Unsafe VM configuration: shared folder or port forwarding exists')
  }
  const attachedDisk = machine['SATA-0-0'] ?? ''
  if (normalizedPath(attachedDisk) !== normalizedPath(VM_SPEC.diskPath)) {
    const imageUuid = String(machine['SATA-ImageUUID-0-0'] ?? '').replace(/[{}]/g, '').toLowerCase()
    const expectedSnapshotPath = join(VM_SPEC.vmDirectory, 'Snapshots', `{${imageUuid}}.vdi`)
    const compactXml = readExactCfgFile(machine).replace(/>\s+</g, '><')
    const parentNeedle = `<HardDisk uuid="{${VM_SPEC.baseDiskUuid}}" location="${basename(VM_SPEC.diskPath)}" format="VDI" type="Normal">`
    const childNeedle = `<HardDisk uuid="{${imageUuid}}" location="Snapshots/{${imageUuid}}.vdi" format="VDI"/>`
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(imageUuid)
      || normalizedPath(attachedDisk) !== normalizedPath(expectedSnapshotPath)
      || !compactXml.includes(`${parentNeedle}${childNeedle}</HardDisk>`)
      || !existsSync(expectedSnapshotPath)
    ) throw new Error('Unsafe VM configuration: unexpected primary disk')
  }
}

function writeEvidence(name, value) {
  mkdirSync(VM_SPEC.evidenceDirectory, { recursive: true })
  const path = join(VM_SPEC.evidenceDirectory, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return path
}

function publicInspection(machine, iso) {
  return {
    recordedAt: new Date().toISOString(),
    vm: machine ? {
      name: machine.name,
      uuid: machine.UUID,
      cfgFile: machine.CfgFile,
      state: machine.VMState,
    } : null,
    iso,
    credential: { path: VM_SPEC.credentialPath, exists: existsSync(VM_SPEC.credentialPath) },
    isolation: {
      guestDataRoot: VM_SPEC.guestDataRoot,
      sharedDataRoot: null,
      network: 'NAT-only',
      portForwarding: false,
      persistentSharedFolders: false,
      clipboard: 'disabled',
      dragAndDrop: 'disabled',
    },
  }
}

export function inspect() {
  const iso = inspectIso()
  const machine = exactMachine({ required: false })
  if (machine) assertIsolatedConfiguration(machine)
  const report = publicInspection(machine, iso)
  report.evidencePath = writeEvidence('inspect.json', report)
  return report
}

export function create() {
  inspectIso()
  const existing = exactMachine({ required: false })
  if (existing) {
    assertIsolatedConfiguration(existing)
    const report = publicInspection(existing, {
      path: VM_SPEC.isoPath,
      size: VM_SPEC.isoSize,
      sha256: VM_SPEC.isoSha256,
    })
    report.created = false
    report.converged = true
    report.evidencePath = writeEvidence('create.json', report)
    return report
  }
  if (existsSync(VM_SPEC.vmDirectory)) {
    throw new Error(`Refusing existing VM directory: ${VM_SPEC.vmDirectory}`)
  }
  for (const [index, planned] of buildCreateCommandPlan().entries()) {
    run(planned.executable, planned.args)
    if (index === 0) exactMachine()
  }
  const machine = exactMachine()
  assertIsolatedConfiguration(machine)
  const report = publicInspection(machine, {
    path: VM_SPEC.isoPath,
    size: VM_SPEC.isoSize,
    sha256: VM_SPEC.isoSha256,
  })
  report.created = true
  report.evidencePath = writeEvidence('create.json', report)
  return report
}

function loadOrCreateCredentials() {
  if (existsSync(VM_SPEC.credentialPath)) {
    const saved = JSON.parse(readFileSync(VM_SPEC.credentialPath, 'utf8'))
    if (saved.task !== 'windows-l1-vm' || saved.vmName !== VM_SPEC.name) {
      throw new Error('Refusing credentials not scoped to the exact VM task')
    }
    if (!saved.username || !saved.password || !saved.fullName) {
      throw new Error('Credential file is incomplete')
    }
    return saved
  }
  mkdirSync(dirname(VM_SPEC.credentialPath), { recursive: true })
  const credentials = {
    version: 1,
    task: 'windows-l1-vm',
    vmName: VM_SPEC.name,
    username: `mpl1${randomBytes(4).toString('hex')}`,
    fullName: 'Mythpen L1 Test Account',
    password: `Mp!${randomBytes(24).toString('base64url')}9a`,
    createdAt: new Date().toISOString(),
  }
  writeFileSync(
    VM_SPEC.credentialPath,
    `${JSON.stringify(credentials, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  )
  chmodSync(VM_SPEC.credentialPath, 0o600)
  return credentials
}

function unattendedArguments(credentials) {
  return [
    'unattended', 'install', VM_SPEC.name,
    `--iso=${VM_SPEC.isoPath}`,
    `--user=${credentials.username}`,
    '--password-file=stdin',
    `--full-user-name=${credentials.fullName}`,
    '--install-additions',
    `--additions-iso=${VM_SPEC.guestAdditionsIsoPath}`,
    '--locale=zh_CN',
    '--country=CN',
    '--time-zone=Asia/Shanghai',
    '--hostname=mythpen-l1.local',
    '--image-index=1',
  ]
}

function guestControlReady(credentials) {
  if (!credentials) return true
  return withPasswordFile(credentials, (passwordFile) => {
    const probe = runVBox([
      'guestcontrol', VM_SPEC.name,
      '--username', credentials.username,
      '--passwordfile', passwordFile,
      'run',
      '--exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '--timeout', '15000',
      '--wait-stdout',
      '--wait-stderr',
      '--',
      ...buildGuestPowerShellArguments("Write-Output 'MYTHPEN_GUEST_READY'"),
    ], { allowFailure: true, secrets: [credentials.password], timeout: 30_000 })
    return probe.status === 0 && probe.stdout.split(/\r?\n/).includes('MYTHPEN_GUEST_READY')
  })
}

function waitForGuestAdditions(
  timeoutMilliseconds = 2 * 60 * 60 * 1000,
  credentials = null,
) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const machine = exactMachine()
    if (machine.VMState === 'running') {
      const probe = runVBox(
        ['guestproperty', 'get', VM_SPEC.name, '/VirtualBox/GuestAdd/Version'],
        { allowFailure: true, timeout: 30_000 },
      )
      if (probe.status === 0 && /^Value: \S+/m.test(probe.stdout) && guestControlReady(credentials)) {
        return probe.stdout.trim().slice(7)
      }
    }
    sleep(15_000)
  }
  throw new Error('Timed out waiting for Windows and Guest Additions')
}

export function install() {
  const machine = exactMachine()
  assertIsolatedConfiguration(machine)
  inspectIso()
  if (!existsSync(VM_SPEC.guestAdditionsIsoPath)) throw new Error('Bundled Guest Additions ISO missing')
  const credentials = loadOrCreateCredentials()
  const secrets = [credentials.password]
  const detected = runVBox(['unattended', 'detect', `--iso=${VM_SPEC.isoPath}`], { secrets })
  const baseArguments = unattendedArguments(credentials)
  runVBox([...baseArguments, '--dry-run'], {
    input: `${credentials.password}\n`,
    secrets,
    timeout: 10 * 60 * 1000,
  })
  runVBox([...baseArguments, '--start-vm=headless'], {
    input: `${credentials.password}\n`,
    secrets,
    timeout: 10 * 60 * 1000,
  })
  const additionsVersion = waitForGuestAdditions(2 * 60 * 60 * 1000, credentials)
  const report = {
    recordedAt: new Date().toISOString(),
    vmName: VM_SPEC.name,
    vmUuid: exactMachine().UUID,
    unattendedDetectSucceeded: detected.status === 0,
    unattendedDryRunSucceeded: true,
    startMode: 'headless',
    guestAdditionsVersion: additionsVersion,
    credential: { path: VM_SPEC.credentialPath, exists: true },
  }
  report.evidencePath = writeEvidence('install.json', report)
  return report
}

function withPasswordFile(credentials, operation) {
  const tempPath = join(dirname(VM_SPEC.credentialPath), `.guest-password-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tempPath, credentials.password, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  chmodSync(tempPath, 0o600)
  try {
    return operation(tempPath)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

export function buildGuestPowerShellArguments(script) {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ]
}

function guestPowerShell(script, credentials, { allowFailure = false } = {}) {
  return withPasswordFile(credentials, (passwordFile) => runVBox([
    'guestcontrol', VM_SPEC.name,
    '--username', credentials.username,
    '--passwordfile', passwordFile,
    'run',
    '--exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    '--timeout', '300000',
    '--wait-stdout',
    '--wait-stderr',
    '--',
    ...buildGuestPowerShellArguments(script),
  ], { allowFailure, secrets: [credentials.password], timeout: 330_000 }))
}

function parseSmokeOutput(output) {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith('MYTHPEN_L1_SMOKE '))
  if (!line) throw new Error('Guest smoke did not emit machine-readable evidence')
  return JSON.parse(line.slice('MYTHPEN_L1_SMOKE '.length))
}

export function buildGuestSmokeScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$root = '${VM_SPEC.guestDataRoot.replaceAll("'", "''")}'`,
    "$volume = Get-Volume -DriveLetter ([System.IO.Path]::GetPathRoot($root).Substring(0,1))",
    "if ($volume.FileSystem -ne 'NTFS') { throw 'Guest test root is not NTFS' }",
    "if ($root.StartsWith('\\\\')) { throw 'Guest test root must not be UNC/shared' }",
    'New-Item -ItemType Directory -Force -Path $root | Out-Null',
    "$probe = Join-Path $root 'durability-smoke.bin'",
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes('mythpen-l1-local-ntfs')",
    "$stream = [System.IO.FileStream]::new($probe, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough)",
    'try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }',
    "$read = [System.IO.File]::ReadAllBytes($probe)",
    "if ([System.Text.Encoding]::UTF8.GetString($read) -ne 'mythpen-l1-local-ntfs') { throw 'Smoke readback mismatch' }",
    '$partitions = @(Get-Partition -DriveLetter $volume.DriveLetter)',
    "if ($partitions.Count -ne 1) { throw 'Guest test volume must map to exactly one partition' }",
    '$disks = @(Get-Disk -Number $partitions[0].DiskNumber)',
    "if ($disks.Count -ne 1) { throw 'Guest test partition must map to exactly one disk' }",
    '$disk = $disks[0]',
    '$logical = [int]$disk.LogicalSectorSize',
    '$physical = [int]$disk.PhysicalSectorSize',
    "if ($logical -le 0 -or $physical -le 0) { throw 'Guest disk sector sizes are invalid' }",
    '$cluster = [int]$volume.AllocationUnitSize',
    '$result = [ordered]@{',
    '  windowsProductName = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion").ProductName',
    '  windowsBuild = [System.Environment]::OSVersion.Version.ToString()',
    '  guestDataRoot = $root',
    '  rootKind = "guest-local"',
    '  fileSystem = $volume.FileSystem',
    '  logicalSectorBytes = $logical',
    '  physicalSectorBytes = $physical',
    '  allocationUnitBytes = $cluster',
    '  writeThroughReadback = $true',
    '}',
    "Write-Output ('MYTHPEN_L1_SMOKE ' + ($result | ConvertTo-Json -Compress))",
  ].join('\n')
}

export function smoke() {
  const machine = exactMachine()
  assertIsolatedConfiguration(machine)
  if (machine.VMState !== 'running') throw new Error('Smoke requires the exact VM to be running')
  const credentials = loadOrCreateCredentials()
  const guestScript = buildGuestSmokeScript()
  const result = guestPowerShell(guestScript, credentials)
  const guest = parseSmokeOutput(result.stdout)
  if (guest.fileSystem !== 'NTFS' || guest.rootKind !== 'guest-local') {
    throw new Error('Guest smoke did not prove a guest-local NTFS root')
  }
  const report = {
    recordedAt: new Date().toISOString(),
    vmName: VM_SPEC.name,
    vmUuid: machine.UUID,
    guest,
    persistentSharedFolders: false,
  }
  report.evidencePath = writeEvidence('smoke.json', report)
  return report
}

function waitForPowerOff(timeoutMilliseconds = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (exactMachine().VMState === 'poweroff') return
    sleep(5_000)
  }
  throw new Error('Timed out waiting for a normal guest shutdown')
}

export function buildExactHeadlessCleanupScript(vmUuid) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(vmUuid)) {
    throw new TypeError('Headless cleanup requires one canonical VM UUID')
  }
  const expectedExecutable = 'D:\\Program Files\\Oracle\\VirtualBox\\VBoxHeadless.exe'
  return [
    "$ErrorActionPreference = 'Stop'",
    `$vmUuid = '${vmUuid.toLowerCase()}'`,
    `$expectedExecutable = '${expectedExecutable}'`,
    '$graceDeadline = [DateTime]::UtcNow.AddSeconds(5)',
    'do {',
    '  $targets = @(Get-CimInstance Win32_Process | Where-Object {',
    "    $_.Name -eq 'VBoxHeadless.exe' -and",
    '    $_.ExecutablePath -eq $expectedExecutable -and',
    "    $_.CommandLine -like ('*--startvm ' + $vmUuid + '*')",
    '  })',
    '  if ($targets.Count -eq 0) { exit 0 }',
    '  if ([DateTime]::UtcNow -lt $graceDeadline) {',
    '    Start-Sleep -Milliseconds 100',
    '    continue',
    '  }',
    '  foreach ($target in $targets) {',
    '    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue',
    '  }',
    '  break',
    '} while ($true)',
    '$forceDeadline = [DateTime]::UtcNow.AddSeconds(15)',
    'do {',
    '  $remaining = @(Get-CimInstance Win32_Process | Where-Object {',
    "    $_.Name -eq 'VBoxHeadless.exe' -and",
    '    $_.ExecutablePath -eq $expectedExecutable -and',
    "    $_.CommandLine -like ('*--startvm ' + $vmUuid + '*')",
    '  })',
    '  if ($remaining.Count -eq 0) { exit 0 }',
    '  Start-Sleep -Milliseconds 100',
    '} while ([DateTime]::UtcNow -lt $forceDeadline)',
    "throw 'Exact target VBoxHeadless processes did not exit'",
  ].join('\n')
}

function terminateExactHeadlessAfterPoweroff(vmUuid) {
  run(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', buildExactHeadlessCleanupScript(vmUuid),
    ],
    { timeout: 30_000 },
  )
}

export function buildGuestShutdownScript() {
  return [
    '$process = Start-Process -FilePath "$env:SystemRoot\\System32\\shutdown.exe" -ArgumentList \'/s\', \'/t\', \'0\' -Wait -PassThru',
    "if ($process.ExitCode -ne 0) { throw 'Guest shutdown request failed' }",
  ].join('\n')
}

function snapshotExists(name) {
  const result = runVBox(['snapshot', VM_SPEC.name, 'list', '--machinereadable'], { allowFailure: true })
  return result.status === 0 && result.stdout.split(/\r?\n/).some((line) => line === `SnapshotName=\"${name}\"`)
}

function hostIoCacheEvidence() {
  const details = runVBox(['showvminfo', VM_SPEC.name]).stdout
  const line = details.split(/\r?\n/).find((candidate) => /SATA.*Host I\/O Cache/i.test(candidate))
  return line?.trim() ?? 'configured off by storagectl command'
}

function vdiEvidence() {
  const result = runVBox(['showmediuminfo', 'disk', VM_SPEC.diskPath, '--machinereadable'])
  const medium = parseMachineReadable(result.stdout)
  return {
    uuid: medium.UUID,
    format: medium.Format,
    capacityMiB: Number(medium.Capacity),
    type: medium.Type,
    location: medium.Location,
  }
}

export function snapshotBaseline() {
  if (snapshotExists(VM_SPEC.baselineSnapshot)) throw new Error('Refusing to replace the immutable baseline snapshot')
  const smokeReport = smoke()
  const credentials = loadOrCreateCredentials()
  guestPowerShell(buildGuestShutdownScript(), credentials)
  waitForPowerOff()
  runVBox([
    'snapshot', VM_SPEC.name, 'take', VM_SPEC.baselineSnapshot,
    '--description', 'Immutable Mythpen Windows L1 clean baseline; restore before each destructive run',
  ], { timeout: 30 * 60 * 1000 })
  if (!snapshotExists(VM_SPEC.baselineSnapshot)) throw new Error('Baseline snapshot was not recorded')
  const machine = exactMachine()
  assertIsolatedConfiguration(machine)
  const report = {
    recordedAt: new Date().toISOString(),
    snapshot: { name: VM_SPEC.baselineSnapshot, exists: true, immutableBaseline: true },
    windows: smokeReport.guest,
    virtualBoxVersion: runVBox(['--version']).stdout.trim(),
    storage: {
      controller: machine.storagecontrollertype0,
      hostIoCache: VM_SPEC.storage.hostIoCache,
      hostIoCacheEvidence: hostIoCacheEvidence(),
    },
    vm: { name: machine.name, uuid: machine.UUID, cfgFile: machine.CfgFile },
    vdi: vdiEvidence(),
    iso: { path: VM_SPEC.isoPath, size: VM_SPEC.isoSize, sha256: VM_SPEC.isoSha256 },
    credential: { path: VM_SPEC.credentialPath, exists: existsSync(VM_SPEC.credentialPath) },
    isolation: {
      guestDataRoot: VM_SPEC.guestDataRoot,
      sharedDataRoot: null,
      network: 'NAT-only',
      portForwarding: false,
      persistentSharedFolders: false,
      clipboard: 'disabled',
      dragAndDrop: 'disabled',
    },
  }
  report.evidencePath = writeEvidence('baseline.json', report)
  return report
}

export function destroyTestRun() {
  const machine = exactMachine()
  assertIsolatedConfiguration(machine)
  if (!snapshotExists(VM_SPEC.baselineSnapshot)) throw new Error('Baseline snapshot is missing')
  if (machine.VMState !== 'poweroff') {
    throw new Error('Refusing hard reset while the VM is not powered off')
  }
  runVBox(['snapshot', VM_SPEC.name, 'restore', VM_SPEC.baselineSnapshot], { timeout: 30 * 60 * 1000 })
  return {
    vmName: VM_SPEC.name,
    vmUuid: exactMachine().UUID,
    restoredSnapshot: VM_SPEC.baselineSnapshot,
    state: 'poweroff',
  }
}

export function buildRollbackMatrixPlan(vmName = VM_SPEC.name) {
  if (vmName !== VM_SPEC.name) throw new Error(`Rollback matrix requires ${VM_SPEC.name}`)
  return WINDOWS_ROLLBACK_CRASH_CASES.map((cut, index) => Object.freeze({
    caseIndex: index + 1,
    cut,
    vmName,
    actions: Object.freeze([
      'restore-baseline',
      'start-headless',
      'wait-guest-additions',
      'copy-probe-to-guest-ntfs',
      'verify-guest-probe-sha256',
      'run-transaction-and-observe-arm',
      'assert-vm-running',
      'external-poweroff',
      'restart-headless',
      'wait-guest-additions',
      'cold-inspect-before-mythpen-open',
      'record-evidence',
    ]),
  }))
}

export function buildDirectoryMatrixPlan(vmName = VM_SPEC.name) {
  if (vmName !== VM_SPEC.name) throw new Error(`Directory matrix requires ${VM_SPEC.name}`)
  return WINDOWS_DIRECTORY_ENTRY_CRASH_CASES.map((entry, index) => Object.freeze({
    caseIndex: index + 1,
    scenario: entry.scenario,
    cut: entry.cut,
    vmName,
    actions: Object.freeze([
      'restore-baseline', 'start-headless', 'wait-guest-additions',
      'copy-probe-to-guest-ntfs', 'verify-guest-probe-sha256',
      'run-case-and-observe-arm', 'assert-vm-running', 'external-poweroff',
      'restart-headless', 'wait-guest-additions', 'cold-inspect-before-mythpen-open',
      'record-evidence',
    ]),
  }))
}

function safeRunDirectoryName() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
}

function writeExactJson(targetPath, value) {
  writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  })
}

function powerOffForMatrix(reason, actions) {
  const machine = exactMachine()
  if (machine.VMState === 'poweroff') return
  if (machine.VMState !== 'running') {
    throw new Error(`Refusing rollback matrix poweroff from VM state ${machine.VMState}`)
  }
  const startedAt = new Date().toISOString()
  runVBox(['controlvm', machine.UUID, 'poweroff'], { timeout: 120_000 })
  waitForPowerOff(120_000)
  terminateExactHeadlessAfterPoweroff(machine.UUID)
  actions.push(Object.freeze({
    action: 'controlvm-poweroff',
    reason,
    startedAt,
    completedAt: new Date().toISOString(),
    observedStateBefore: 'running',
    observedStateAfter: 'poweroff',
  }))
}

function startExactVm(actions, reason, credentials) {
  const before = exactMachine()
  if (before.VMState !== 'poweroff') {
    throw new Error(`Refusing to start rollback matrix VM from ${before.VMState}`)
  }
  terminateExactHeadlessAfterPoweroff(before.UUID)
  const startedAt = new Date().toISOString()
  runVBox(['startvm', before.UUID, '--type', 'headless'], { timeout: 120_000 })
  const additionsVersion = waitForGuestAdditions(15 * 60 * 1000, credentials)
  const running = exactMachine()
  if (running.VMState !== 'running') throw new Error('Rollback matrix VM did not remain running')
  actions.push(Object.freeze({
    action: 'start-headless',
    reason,
    startedAt,
    completedAt: new Date().toISOString(),
    observedStateAfter: running.VMState,
    guestAdditionsVersion: additionsVersion,
  }))
}

function restoreBaselineForMatrix(actions) {
  const machine = exactMachine()
  assertIsolatedConfiguration(machine)
  if (!snapshotExists(VM_SPEC.baselineSnapshot)) throw new Error('Rollback matrix baseline is missing')
  if (machine.VMState !== 'poweroff') throw new Error('Baseline restore requires a powered-off VM')
  const startedAt = new Date().toISOString()
  runVBox(['snapshot', machine.UUID, 'restore', VM_SPEC.baselineSnapshot], {
    timeout: 30 * 60 * 1000,
  })
  const restored = exactMachine()
  assertIsolatedConfiguration(restored)
  if (restored.VMState !== 'poweroff') throw new Error('Baseline restore did not remain powered off')
  actions.push(Object.freeze({
    action: 'restore-baseline',
    snapshot: VM_SPEC.baselineSnapshot,
    startedAt,
    completedAt: new Date().toISOString(),
    observedStateAfter: restored.VMState,
  }))
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function prepareGuestProbe({ credentials, guestControlDirectory, guestProbe, guestRoot, hostProbe }) {
  const hostSha = sha256(hostProbe)
  guestPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force -Path ${quotePowerShell(dirname(guestProbe))} | Out-Null`,
    `New-Item -ItemType Directory -Force -Path ${quotePowerShell(dirname(guestRoot))} | Out-Null`,
    `New-Item -ItemType Directory -Force -Path ${quotePowerShell(guestControlDirectory)} | Out-Null`,
    `if (Test-Path -LiteralPath ${quotePowerShell(guestRoot)}) { Remove-Item -LiteralPath ${quotePowerShell(guestRoot)} -Recurse -Force }`,
    `New-Item -ItemType Directory -Path ${quotePowerShell(guestRoot)} | Out-Null`,
  ].join('\n'), credentials)
  withPasswordFile(credentials, (passwordFile) => runVBox([
    'guestcontrol', VM_SPEC.name,
    'copyto',
    `--username=${credentials.username}`,
    `--passwordfile=${passwordFile}`,
    `--target-directory=${guestProbe}`,
    hostProbe,
  ], { secrets: [credentials.password], timeout: 10 * 60 * 1000 }))
  const verify = guestPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath ${quotePowerShell(guestProbe)}).Hash.ToUpperInvariant()`,
    `if ($digest -ne '${hostSha}') { throw 'Guest probe SHA-256 mismatch' }`,
    "Write-Output ('MYTHPEN_PROBE_SHA ' + $digest)",
  ].join('\n'), credentials)
  if (!verify.stdout.split(/\r?\n/).includes(`MYTHPEN_PROBE_SHA ${hostSha}`)) {
    throw new Error('Guest probe SHA-256 post-check was not exact')
  }
  return hostSha
}

function startGuestProbe({ credentials, guestControlDirectory, guestProbe, guestRoot, cut, armId }) {
  const passwordFile = join(
    dirname(VM_SPEC.credentialPath),
    `.guest-password-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  )
  writeFileSync(passwordFile, credentials.password, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  chmodSync(passwordFile, 0o600)
  const child = spawn(VM_SPEC.vboxManagePath, [
    'guestcontrol', VM_SPEC.name,
    '--username', credentials.username,
    '--passwordfile', passwordFile,
    'run',
    '--exe', guestProbe,
    '--timeout', '0',
    '--wait-stdout',
    '--wait-stderr',
    '--',
    'run-transaction', guestRoot, cut, armId, guestControlDirectory,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return Object.freeze({ child, passwordFile })
}

function startDirectoryGuestProbe({ credentials, guestControlDirectory, guestProbe, guestRoot, scenario, armId }) {
  const passwordFile = join(dirname(VM_SPEC.credentialPath), `.guest-password-${process.pid}-${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(passwordFile, credentials.password, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  chmodSync(passwordFile, 0o600)
  const child = spawn(VM_SPEC.vboxManagePath, [
    'guestcontrol', VM_SPEC.name, '--username', credentials.username, '--passwordfile', passwordFile,
    'run', '--exe', guestProbe, '--timeout', '0', '--wait-stdout', '--wait-stderr', '--',
    'run-case', guestRoot, scenario, armId, guestControlDirectory,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  return Object.freeze({ child, passwordFile })
}

function waitForArmFrame(started, { armId, cut, timeoutMilliseconds = 10 * 60 * 1000 }) {
  const child = started.child
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  let settled = false
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      rejectPromise(new Error(`Timed out waiting for rollback arm frame: ${redact(stderr)}`))
    }, timeoutMilliseconds)
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      callback(value)
    }
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame?.type !== 'windows.native.rollback.arm.v2') continue
        if (frame.armId !== armId || frame.cut !== cut || frame.version !== 2) {
          finish(rejectPromise, new Error('Rollback probe published an inexact arm frame'))
          return
        }
        finish(resolvePromise, Object.freeze({ frame, stderr: redact(stderr) }))
        return
      }
    })
    child.once('error', (error) => finish(rejectPromise, error))
    child.once('exit', (code, signal) => finish(
      rejectPromise,
      new Error(`Rollback probe exited before poweroff: code=${code} signal=${signal} ${redact(stderr)}`),
    ))
  })
}

function waitForDirectoryArmFrame(started, { armId, scenario, timeoutMilliseconds = 10 * 60 * 1000 }) {
  const child = started.child
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  let stdout = ''; let stderr = ''; let settled = false
  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => finish(rejectPromise, new Error(`Timed out waiting for directory arm frame: ${redact(stderr)}`)), timeoutMilliseconds)
    const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timeout); callback(value) }
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.stdout.on('data', (chunk) => {
      stdout += chunk; const lines = stdout.split(/\r?\n/); stdout = lines.pop() ?? ''
      for (const line of lines) {
        let frame; try { frame = JSON.parse(line) } catch { continue }
        if (frame?.type !== 'windows.native.directory.arm.v1') continue
        if (frame.armId !== armId || frame.scenario !== scenario || frame.version !== 1) {
          finish(rejectPromise, new Error('Directory probe published an inexact arm frame')); return
        }
        finish(resolvePromise, Object.freeze({ frame, stderr: redact(stderr) })); return
      }
    })
    child.once('error', (error) => finish(rejectPromise, error))
    child.once('exit', (code, signal) => finish(rejectPromise, new Error(`Directory probe exited before poweroff: code=${code} signal=${signal} ${redact(stderr)}`)))
  })
}

export function terminateGuestControlAfterPoweroff(child, timeoutMilliseconds = 120_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
      callback(value)
    }
    const onExit = () => finish(resolvePromise)
    const onError = (error) => finish(rejectPromise, error)
    const timeout = setTimeout(
      () => finish(
        rejectPromise,
        new Error('Timed out terminating guestcontrol after VM poweroff'),
      ),
      timeoutMilliseconds,
    )
    child.once('exit', onExit)
    child.once('error', onError)
    try {
      child.kill()
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(resolvePromise)
      }
    } catch (error) {
      finish(rejectPromise, error)
    }
  })
}

function coldInspectGuest({ credentials, guestProbe, guestRoot, armId }) {
  return withPasswordFile(credentials, (passwordFile) => {
    const result = runVBox([
      'guestcontrol', VM_SPEC.name,
      '--username', credentials.username,
      '--passwordfile', passwordFile,
      'run',
      '--exe', guestProbe,
      '--timeout', '600000',
      '--wait-stdout',
      '--wait-stderr',
      '--',
      'cold-inspect', guestRoot, armId,
    ], { secrets: [credentials.password], timeout: 11 * 60 * 1000 })
    const frames = result.stdout.split(/\r?\n/).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    const inspections = frames.filter((frame) => (
      frame?.type === 'windows.native.rollback.cold-inspection.v2'
    ))
    if (inspections.length !== 1 || inspections[0].armId !== armId) {
      throw new Error(`Cold inspection did not emit one exact frame: ${redact(result.stderr)}`)
    }
    return inspections[0]
  })
}

export function buildDirectoryColdInspectArguments({ guestRoot, scenario, armId, guestControlDirectory }) {
  return Object.freeze(['cold-inspect', guestRoot, scenario, armId, guestControlDirectory])
}

function coldInspectDirectoryGuest({ credentials, guestProbe, guestRoot, scenario, armId, guestControlDirectory }) {
  return withPasswordFile(credentials, (passwordFile) => {
    const result = runVBox([
      'guestcontrol', VM_SPEC.name, '--username', credentials.username, '--passwordfile', passwordFile,
      'run', '--exe', guestProbe, '--timeout', '600000', '--wait-stdout', '--wait-stderr', '--',
      ...buildDirectoryColdInspectArguments({ guestRoot, scenario, armId, guestControlDirectory }),
    ], { secrets: [credentials.password], timeout: 11 * 60 * 1000 })
    const inspections = result.stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
      .filter((frame) => frame?.type === 'windows.native.directory.cold-inspection.v1')
    if (inspections.length !== 1 || inspections[0].armId !== armId) throw new Error(`Directory cold inspection did not emit one exact frame: ${redact(result.stderr)}`)
    return inspections[0]
  })
}

function assertColdInspection(cut, arm, cold) {
  const expectedAfter = ![
    'native.caller.after-source-postcheck',
    'native.tx.after-prepared-postcheck',
    'native.tx.after-begin-acquired',
    'native.tx.after-gate-insert',
    'native.tx.after-business-callback',
    'native.tx.after-seq-cas',
    'native.tx.after-gate-delete',
    'native.tx.before-commit-invoke',
  ].includes(cut)
  if (
    cold.cut !== cut
    || cold.armId !== arm.armId
    || JSON.stringify(cold.binding) !== JSON.stringify(arm.binding)
    || cold.convergence?.outcome !== (expectedAfter ? 'after' : 'before')
    || cold.convergence?.finalSeq !== (expectedAfter ? 1 : 0)
    || cold.convergence?.gateEmpty !== true
    || cold.externalVmResetVerified !== false
    || cold.capability !== false
  ) throw new Error(`Cold inspection rejected canonical convergence for ${cut}`)
}

export function assertDirectoryColdInspection(current, arm, cold) {
  if (
    cold.scenario !== current.scenario || cold.cut !== current.cut || cold.armId !== arm.armId
    || cold.convergence?.canonical !== true || cold.convergence?.secondReopenStable !== true
    || cold.externalVmResetVerified !== false || cold.capability !== false
  ) throw new Error(`Directory cold inspection rejected canonical convergence for ${current.scenario}`)
  assertExactDirectoryBinding(arm.binding, cold.binding)
  if (current.scenario.startsWith('activation-aborted-') && (
    cold.convergence?.kind !== 'activation-schema10'
    || cold.convergence?.schemaVersion !== 10
    || cold.convergence?.nativeStateAbsent !== true
    || cold.convergence?.abortedCount !== 1
    || cold.convergence?.activatedCount !== 0
    || cold.convergence?.activationEvents !== 2
  )) throw new Error(`Directory cold inspection rejected exact activation-aborted recovery for ${current.scenario}`)
}

export function assertExactDirectoryBinding(expected, observed) {
  const equal = (left, right) => {
    if (left === right) return true
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false
    const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort()
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && equal(left[key], right[key]))
  }
  if (!equal(expected, observed)) throw new Error('Directory cold inspection binding differs from the reset-before arm')
}

export async function runRollbackMatrix({ vm = VM_SPEC.name } = {}) {
  const plan = buildRollbackMatrixPlan(vm)
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const compiled = buildWindowsNativeRollbackProbe(repositoryRoot)
  const credentials = loadOrCreateCredentials()
  const runId = safeRunDirectoryName()
  const runDirectory = join(VM_SPEC.rollbackEvidenceDirectory, runId)
  mkdirSync(VM_SPEC.rollbackEvidenceDirectory, { recursive: true })
  mkdirSync(runDirectory, { recursive: false })
  const probeSha256 = sha256(compiled.probe)
  const manifest = {
    version: 1,
    type: 'windows.native.rollback.matrix.v1',
    runId,
    startedAt: new Date().toISOString(),
    vm: { name: VM_SPEC.name, uuid: null, baselineSnapshot: VM_SPEC.baselineSnapshot },
    probe: {
      path: compiled.probe,
      sha256: probeSha256,
      sourceCommit: compiled.sourceCommit,
      targetTriple: compiled.triple,
    },
    rows: [],
    capability: false,
  }
  writeExactJson(join(runDirectory, 'manifest.started.json'), manifest)

  for (const current of plan) {
    const rowDirectory = join(runDirectory, String(current.caseIndex).padStart(2, '0'))
    mkdirSync(rowDirectory)
    const actions = []
    const armId = randomUUID()
    const guestRoot = `${VM_SPEC.guestDataRoot}\\runs\\${ROOT_PREFIX}${armId}`
    const guestControlDirectory = `C:\\Mythpen-L1-Control\\${CONTROL_PREFIX}${armId}`
    const guestProbe = `${VM_SPEC.guestDataRoot}\\bin\\mythpen-native-rollback-probe.exe`
    let started = null
    let rowError = null
    try {
      restoreBaselineForMatrix(actions)
      startExactVm(actions, 'prepare-row', credentials)
      const guestSha = prepareGuestProbe({
        credentials,
        guestControlDirectory,
        guestProbe,
        guestRoot,
        hostProbe: compiled.probe,
      })
      if (guestSha !== probeSha256) throw new Error('Guest probe differs from compiled probe')
      actions.push(Object.freeze({
        action: 'copy-and-verify-probe',
        completedAt: new Date().toISOString(),
        guestPath: guestProbe,
        sha256: guestSha,
      }))
      started = startGuestProbe({
        credentials,
        guestControlDirectory,
        guestProbe,
        guestRoot,
        cut: current.cut,
        armId,
      })
      const armed = await waitForArmFrame(started, { armId, cut: current.cut })
      const running = exactMachine()
      if (running.VMState !== 'running') throw new Error('VM was not running at the external arm')
      manifest.vm.uuid = running.UUID
      writeExactJson(join(rowDirectory, 'arm.json'), armed.frame)
      actions.push(Object.freeze({
        action: 'observe-external-arm',
        completedAt: new Date().toISOString(),
        observedVmState: running.VMState,
      }))
      powerOffForMatrix('evidence-hard-reset', actions)
      await terminateGuestControlAfterPoweroff(started.child)
      rmSync(started.passwordFile, { force: true })
      started = null
      startExactVm(actions, 'cold-inspection', credentials)
      const cold = coldInspectGuest({ credentials, guestProbe, guestRoot, armId })
      assertColdInspection(current.cut, armed.frame, cold)
      writeExactJson(join(rowDirectory, 'cold.json'), cold)
      actions.push(Object.freeze({
        action: 'cold-inspect-before-mythpen-open',
        completedAt: new Date().toISOString(),
        convergence: cold.convergence,
      }))
      powerOffForMatrix('post-verification-cleanup', actions)
      const row = Object.freeze({
        caseIndex: current.caseIndex,
        cut: current.cut,
        armId,
        externalVmResetVerified: true,
        capability: false,
        binding: armed.frame.binding,
        convergence: cold.convergence,
        actions,
      })
      writeExactJson(join(rowDirectory, 'row.json'), row)
      manifest.rows.push(row)
    } catch (error) {
      rowError = error
      throw error
    } finally {
      try {
        const machine = exactMachine()
        if (machine.VMState === 'running') powerOffForMatrix('failed-row-cleanup', actions)
        if (started !== null) await terminateGuestControlAfterPoweroff(started.child)
      } catch (cleanupError) {
        if (rowError) rowError.cleanupError = cleanupError
        else throw cleanupError
      }
      if (started !== null) rmSync(started.passwordFile, { force: true })
      if (rowError) {
        writeFileSync(join(rowDirectory, 'failure.json'), `${JSON.stringify({
          cut: current.cut,
          armId,
          error: redact(rowError?.message || rowError),
          actions,
        }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      }
    }
  }
  manifest.completedAt = new Date().toISOString()
  manifest.complete = manifest.rows.length === WINDOWS_ROLLBACK_CRASH_CASES.length
  writeExactJson(join(runDirectory, 'manifest.complete.json'), manifest)
  return Object.freeze({
    runDirectory,
    rows: manifest.rows.length,
    complete: manifest.complete,
    capability: false,
    probeSha256,
  })
}

export async function runDirectoryMatrix({ vm = VM_SPEC.name } = {}) {
  const plan = buildDirectoryMatrixPlan(vm)
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const compiled = buildWindowsNativeDirectoryProbe(repositoryRoot)
  const credentials = loadOrCreateCredentials()
  const runId = safeRunDirectoryName()
  const runDirectory = join(VM_SPEC.directoryEvidenceDirectory, runId)
  mkdirSync(VM_SPEC.directoryEvidenceDirectory, { recursive: true }); mkdirSync(runDirectory, { recursive: false })
  const probeSha256 = sha256(compiled.probe)
  const manifest = { version: 1, type: 'windows.native.directory.matrix.v1', runId, startedAt: new Date().toISOString(), vm: { name: VM_SPEC.name, uuid: null, baselineSnapshot: VM_SPEC.baselineSnapshot }, probe: { path: compiled.probe, sha256: probeSha256, sourceCommit: compiled.sourceCommit, targetTriple: compiled.triple }, rows: [], capability: false }
  writeExactJson(join(runDirectory, 'manifest.started.json'), manifest)
  for (const current of plan) {
    const rowDirectory = join(runDirectory, String(current.caseIndex).padStart(2, '0')); mkdirSync(rowDirectory)
    const actions = []; const armId = randomUUID(); const guestRoot = `${VM_SPEC.guestDirectoryRoot}\\${DIRECTORY_ROOT_PREFIX}${armId}`
    const guestControlDirectory = `C:\\Mythpen-L1-Control\\directory-${armId}`
    const guestProbe = `${VM_SPEC.guestDataRoot}\\bin\\mythpen-native-directory-probe.exe`
    let started = null; let rowError = null
    try {
      restoreBaselineForMatrix(actions); startExactVm(actions, 'prepare-directory-row', credentials)
      const guestSha = prepareGuestProbe({ credentials, guestControlDirectory, guestProbe, guestRoot, hostProbe: compiled.probe })
      if (guestSha !== probeSha256) throw new Error('Guest directory probe differs from compiled probe')
      actions.push(Object.freeze({ action: 'copy-and-verify-probe', completedAt: new Date().toISOString(), guestPath: guestProbe, sha256: guestSha }))
      started = startDirectoryGuestProbe({ credentials, guestControlDirectory, guestProbe, guestRoot, scenario: current.scenario, armId })
      const armed = await waitForDirectoryArmFrame(started, { armId, scenario: current.scenario })
      const running = exactMachine(); if (running.VMState !== 'running') throw new Error('VM was not running at the directory external arm')
      manifest.vm.uuid = running.UUID; writeExactJson(join(rowDirectory, 'arm.json'), armed.frame)
      actions.push(Object.freeze({ action: 'observe-external-arm', completedAt: new Date().toISOString(), observedVmState: running.VMState }))
      powerOffForMatrix('directory-evidence-hard-reset', actions); await terminateGuestControlAfterPoweroff(started.child); rmSync(started.passwordFile, { force: true }); started = null
      startExactVm(actions, 'directory-cold-inspection', credentials)
      const cold = coldInspectDirectoryGuest({ credentials, guestProbe, guestRoot, scenario: current.scenario, armId, guestControlDirectory }); writeExactJson(join(rowDirectory, 'cold.observed.json'), cold); assertDirectoryColdInspection(current, armed.frame, cold)
      writeExactJson(join(rowDirectory, 'cold.json'), cold); actions.push(Object.freeze({ action: 'cold-inspect-before-mythpen-open', completedAt: new Date().toISOString(), convergence: cold.convergence }))
      powerOffForMatrix('directory-post-verification-cleanup', actions)
      const row = Object.freeze({ caseIndex: current.caseIndex, scenario: current.scenario, cut: current.cut, armId, externalVmResetVerified: true, capability: false, binding: armed.frame.binding, convergence: cold.convergence, actions })
      writeExactJson(join(rowDirectory, 'row.json'), row); manifest.rows.push(row)
    } catch (error) { rowError = error; throw error } finally {
      try { const machine = exactMachine(); if (machine.VMState === 'running') powerOffForMatrix('directory-failed-row-cleanup', actions); if (started !== null) await terminateGuestControlAfterPoweroff(started.child) } catch (cleanupError) { if (rowError) rowError.cleanupError = cleanupError; else throw cleanupError }
      if (started !== null) rmSync(started.passwordFile, { force: true })
      if (rowError) writeFileSync(join(rowDirectory, 'failure.json'), `${JSON.stringify({ scenario: current.scenario, armId, error: redact(rowError?.message || rowError), actions }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    }
  }
  manifest.completedAt = new Date().toISOString(); manifest.complete = manifest.rows.length === WINDOWS_DIRECTORY_ENTRY_CRASH_CASES.length
  writeExactJson(join(runDirectory, 'manifest.complete.json'), manifest)
  return Object.freeze({ runDirectory, rows: manifest.rows.length, complete: manifest.complete, capability: false, probeSha256, sourceCommit: compiled.sourceCommit })
}

const COMMANDS = new Map([
  ['inspect', inspect],
  ['create', create],
  ['install', install],
  ['snapshot-baseline', snapshotBaseline],
  ['smoke', smoke],
  ['destroy-test-run', destroyTestRun],
  ['run-rollback-matrix', runRollbackMatrix],
  ['run-directory-matrix', runDirectoryMatrix],
])

async function main() {
  const action = process.argv[2]
  const handler = COMMANDS.get(action)
  let options
  if (action === 'run-rollback-matrix' || action === 'run-directory-matrix') {
    if (process.argv.length !== 5 || process.argv[3] !== '--vm') {
      throw new Error(`Usage: node scripts/windows-l1-vm.mjs ${action} --vm ${VM_SPEC.name}`)
    }
    options = { vm: process.argv[4] }
  } else if (!handler || process.argv.length !== 3) {
    throw new Error(`Usage: node scripts/windows-l1-vm.mjs <${[...COMMANDS.keys()].join('|')}>`)
  }
  if (!handler) throw new Error(`Unknown Windows L1 VM command: ${action}`)
  const result = await handler(options)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (entryPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`WINDOWS_L1_VM_ERROR ${redact(error?.message || error)}\n`)
    process.exitCode = 1
  })
}
