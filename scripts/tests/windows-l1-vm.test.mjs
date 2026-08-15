import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('pins the isolated Windows L1 VM baseline and its create command plan', async () => {
  const { VM_SPEC, buildCreateCommandPlan } = await import('../windows-l1-vm.mjs')
  const plan = buildCreateCommandPlan()
  const allArguments = plan.flatMap(({ args }) => args)

  const checks = [
    ['exact VM name', VM_SPEC.name, 'Mythpen-L1-Win10-LTSC2021'],
    [
      'exact VM directory',
      VM_SPEC.vmDirectory,
      'D:\\Mythpen\\l1-vm\\VirtualBox\\Mythpen-L1-Win10-LTSC2021',
    ],
    [
      'exact ISO path',
      VM_SPEC.isoPath,
      'D:\\Mythpen\\l1-vm\\downloads\\Windows10EnterpriseLTSC2021Eval-x64-zh-cn.iso',
    ],
    [
      'exact ISO SHA-256',
      VM_SPEC.isoSha256,
      '2181EAAEED2F1A78BE41F45692671DB050D9FF76291F767AB696147C8A322DA3',
    ],
    ['guest OS type', VM_SPEC.osType, 'Windows10_64'],
    ['CPU count', VM_SPEC.cpus, 2],
    ['RAM MiB', VM_SPEC.memoryMiB, 4096],
    ['dynamic VDI size MiB', VM_SPEC.diskSizeMiB, 64 * 1024],
    ['base VDI UUID', VM_SPEC.baseDiskUuid, '60a78c82-ddda-4cd0-9010-b284dfa25b5b'],
    ['SATA controller', VM_SPEC.storage.controller, 'IntelAhci'],
    ['SATA host I/O cache', VM_SPEC.storage.hostIoCache, 'off'],
    ['primary NIC', VM_SPEC.network.nic1, 'nat'],
    ['other NICs', VM_SPEC.network.otherNics, 'none'],
    ['shared data root', VM_SPEC.sharedDataRoot, null],
  ]

  for (const [label, actual, expected] of checks) {
    assert.deepEqual(actual, expected, label)
  }

  assert.ok(plan.every(({ executable, args }) => (
    executable === VM_SPEC.vboxManagePath
    && Array.isArray(args)
    && args.every((argument) => typeof argument === 'string')
  )))
  assert.ok(plan.some(({ args }) => (
    args[0] === 'createmedium'
    && args.includes('--format')
    && args.includes('VDI')
    && args.includes('--variant')
    && args.includes('Standard')
    && args.includes(String(64 * 1024))
  )), 'dynamic 64 GiB VDI command')
  assert.ok(plan.some(({ args }) => (
    args[0] === 'storagectl'
    && args.includes('IntelAhci')
    && args.includes('--hostiocache')
    && args.includes('off')
  )), 'SATA AHCI host I/O cache off command')
  assert.ok(plan.some(({ args }) => (
    args[0] === 'modifyvm'
    && args.includes('--cpus')
    && args.includes('2')
    && args.includes('--memory')
    && args.includes('4096')
    && args.includes('--nic1')
    && args.includes('nat')
    && args.includes('--nic2')
    && args.includes('none')
  )), 'CPU, RAM, and NAT-only command')
  assert.ok(allArguments.includes(VM_SPEC.name), 'commands target the exact VM name')
  assert.equal(allArguments.some((argument) => /sharedfolder|natpf/i.test(argument)), false)
})

test('requires the exact internal Windows OS type ID and its exact VirtualBox display mapping', async () => {
  const { validateWindowsOsTypeEvidence } = await import('../windows-l1-vm.mjs')
  const configXml = '<Machine name="Mythpen-L1-Win10-LTSC2021" OSType="Windows10_64">'
  const legacyOstypes = ['ID:          Windows10_64', 'Description: Windows 10 (64-bit)'].join('\n')
  const currentOstypes = [
    'ID / Description: Windows10_64 -- Windows 10 (64-bit)',
    'Family:           Windows (Microsoft Windows)',
    'Architecture:     x86 (64-bit)',
  ].join('\n')

  for (const ostypes of [legacyOstypes, currentOstypes]) {
    assert.deepEqual(validateWindowsOsTypeEvidence({
      configXml,
      ostypes,
      showVmInfoOsType: 'Windows 10 (64-bit)',
    }), {
      id: 'Windows10_64',
      display: 'Windows 10 (64-bit)',
    })
  }

  const wrongEvidence = [
    { configXml: configXml.replace('Windows10_64', 'Windows11_64'), ostypes: currentOstypes, showVmInfoOsType: 'Windows 10 (64-bit)' },
    { configXml, ostypes: currentOstypes, showVmInfoOsType: 'Windows 11 (64-bit)' },
    { configXml, ostypes: currentOstypes.replace('Windows 10 (64-bit)', 'Windows 11 (64-bit)'), showVmInfoOsType: 'Windows 10 (64-bit)' },
    { configXml, ostypes: currentOstypes.replace('Windows10_64', 'Windows11_64'), showVmInfoOsType: 'Windows 10 (64-bit)' },
  ]
  for (const evidence of wrongEvidence) {
    assert.throws(() => validateWindowsOsTypeEvidence(evidence), /OS type/i)
  }
})

test('strictly parses VirtualBox machine-readable keys and path encodings', async () => {
  const { parseMachineReadable } = await import('../windows-l1-vm.mjs')
  const output = [
    'name="Mythpen-L1-Win10-LTSC2021"',
    String.raw`CfgFile="D:\\Mythpen\\l1-vm\\VirtualBox\\Mythpen-L1-Win10-LTSC2021\\Mythpen-L1-Win10-LTSC2021.vbox"`,
    String.raw`"SATA-0-0"="D:\Mythpen\l1-vm\VirtualBox\Mythpen-L1-Win10-LTSC2021\Mythpen-L1-Win10-LTSC2021.vdi"`,
    'memory=4096',
    ' rec_screen0',
    'VideoMode="1024,768,32"@0,0 1',
    'VRDEClients==0',
    'GuestAdditionsFacility_VirtualBox Base Driver=50,1786680588544',
    'GuestAdditionsFacility_VirtualBox System Service=50,1786680615854',
    'GuestAdditionsFacility_VirtualBox Desktop Integration=50,1786680667841',
    'GuestAdditionsFacility_Seamless Mode=0,1786680588559',
    'GuestAdditionsFacility_Graphics Mode=0,1786680588539',
    'rec_screen_enabled="on"',
  ].join('\n')

  assert.deepEqual(parseMachineReadable(output), {
    name: 'Mythpen-L1-Win10-LTSC2021',
    CfgFile: 'D:\\Mythpen\\l1-vm\\VirtualBox\\Mythpen-L1-Win10-LTSC2021\\Mythpen-L1-Win10-LTSC2021.vbox',
    'SATA-0-0': 'D:\\Mythpen\\l1-vm\\VirtualBox\\Mythpen-L1-Win10-LTSC2021\\Mythpen-L1-Win10-LTSC2021.vdi',
    memory: '4096',
    rec_screen_enabled: 'on',
  })

  const rejected = [
    'name="first"\nname="duplicate"',
    'name="unterminated',
    String.raw`CfgFile="D:\\\Mythpen"`,
    String.raw`CfgFile="D:\\Mythpen\l1-vm"`,
    String.raw`"bad\key"="value"`,
    'VideoMode="1024,768,32"@0,0 2',
    'VideoMode="1024,768,32"@0,0 1 trailing',
    'VRDEClients==-1',
    'VRDEClients==0 trailing',
    'GuestAdditionsFacility_Unknown Mode=0,1786680588539',
    'GuestAdditionsFacility_Graphics Mode=0,-1',
    ' unknown_section',
  ]
  for (const malformed of rejected) {
    assert.throws(() => parseMachineReadable(malformed), /machine-readable/i)
  }
})

test('builds syntactically valid guest smoke PowerShell', async () => {
  const { buildGuestSmokeScript } = await import('../windows-l1-vm.mjs')
  assert.equal(typeof buildGuestSmokeScript, 'function')

  const script = buildGuestSmokeScript()
  const parser = [
    '$inputText = [Console]::In.ReadToEnd()',
    '$tokens = $null',
    '$errors = $null',
    '[System.Management.Automation.Language.Parser]::ParseInput($inputText, [ref]$tokens, [ref]$errors) | Out-Null',
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }',
  ].join('; ')
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command', parser,
  ], { encoding: 'utf8', input: script })

  assert.equal(result.status, 0, result.stderr)
  assert.match(script, /\[ordered\]@\{\r?\n/)
  assert.match(script, /Get-Partition -DriveLetter \$volume\.DriveLetter/)
  assert.match(script, /Get-Disk -Number \$partitions\[0\]\.DiskNumber/)
  assert.doesNotMatch(script, /Get-Disk -Number 0/)
  assert.doesNotMatch(script, /Bytes Per (?:Physical )?Sector/)
  assert.doesNotMatch(script, /@\{;/)
})

test('requests a normal guest shutdown without a forced poweroff', async () => {
  const { buildGuestShutdownScript } = await import('../windows-l1-vm.mjs')
  assert.equal(typeof buildGuestShutdownScript, 'function')

  const script = buildGuestShutdownScript()
  assert.match(script, /shutdown\.exe.*\/s.*\/t.*0/i)
  assert.doesNotMatch(script, /(?:\/f|poweroff)/i)
  assert.doesNotMatch(script, /(^|\r?\n)\s*&/)
})

test('does not repeat the guest PowerShell executable as argv0', async () => {
  const { buildGuestPowerShellArguments } = await import('../windows-l1-vm.mjs')
  assert.equal(typeof buildGuestPowerShellArguments, 'function')

  const args = buildGuestPowerShellArguments('Write-Output ok')
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', 'Write-Output ok',
  ])
  assert.doesNotMatch(args.join(' '), /powershell\.exe/i)
})

test('freezes the exact externally powered-off rollback matrix sequence', async () => {
  const { VM_SPEC, buildRollbackMatrixPlan } = await import('../windows-l1-vm.mjs')
  const expectedCuts = [
    'native.caller.after-source-postcheck',
    'native.tx.after-prepared-postcheck',
    'native.tx.after-begin-acquired',
    'native.tx.after-gate-insert',
    'native.tx.after-business-callback',
    'native.tx.after-seq-cas',
    'native.tx.after-gate-delete',
    'native.tx.before-commit-invoke',
    'native.tx.after-commit-return',
    'native.tx.before-terminal-append',
    'controlstore.append.before-publish',
    'controlstore.append.before-dir-fsync',
    'native.tx.after-terminal-postcheck',
  ]
  const plan = buildRollbackMatrixPlan(VM_SPEC.name)

  assert.deepEqual(plan.map(({ cut }) => cut), expectedCuts)
  assert.equal(Object.isFrozen(plan[0]), true)
  assert.equal(Object.isFrozen(plan[0].actions), true)
  for (const row of plan) {
    assert.deepEqual(row.actions, [
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
    ])
  }
  assert.throws(
    () => buildRollbackMatrixPlan('ubuntu-16.04.6-desktop-amd64'),
    /Mythpen-L1-Win10-LTSC2021/,
  )
})

test('freezes the exact 19-row externally powered-off directory matrix sequence', async () => {
  const { VM_SPEC, buildDirectoryMatrixPlan } = await import('../windows-l1-vm.mjs')
  const plan = buildDirectoryMatrixPlan(VM_SPEC.name)
  assert.equal(plan.length, 19)
  assert.deepEqual(plan.map(({ caseIndex, scenario }) => [caseIndex, scenario]), [
    [1, 'generic-event-before-publish'], [2, 'generic-event-before-dir-fsync'],
    [3, 'checkpoint-tail-before-publish'], [4, 'checkpoint-tail-before-dir-fsync'],
    [5, 'checkpoint-before-publish'], [6, 'checkpoint-before-candidate-unlink'],
    [7, 'checkpoint-before-final-dir-fsync'], [8, 'checkpoint-after-final-dir-fsync'],
    [9, 'checkpoint-before-gc'], [10, 'checkpoint-after-gc-event'],
    [11, 'checkpoint-after-gc-old-checkpoint'], [12, 'checkpoint-before-gc-dir-fsync'],
    [13, 'retire-before-dir-fsync'], [14, 'activation-prepared-before-publish'],
    [15, 'activation-prepared-before-dir-fsync'], [16, 'activation-activated-before-publish'],
    [17, 'activation-activated-before-dir-fsync'], [18, 'activation-aborted-before-publish'],
    [19, 'activation-aborted-before-dir-fsync'],
  ])
  assert.ok(plan.every((row) => Object.isFrozen(row) && Object.isFrozen(row.actions)))
  assert.throws(() => buildDirectoryMatrixPlan('ubuntu-16.04.6-desktop-amd64'), /Mythpen-L1-Win10-LTSC2021/)
})

test('passes the exact independent control-plane fields to directory cold inspection', async () => {
  const { buildDirectoryColdInspectArguments } = await import('../windows-l1-vm.mjs')
  assert.deepEqual(buildDirectoryColdInspectArguments({
    guestRoot: 'C:\\MythpenProbe\\runs\\mythpen-native-directory-vm-f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
    scenario: 'generic-event-before-publish',
    armId: 'f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
    guestControlDirectory: 'C:\\Mythpen-L1-Control\\directory-f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
  }), [
    'cold-inspect',
    'C:\\MythpenProbe\\runs\\mythpen-native-directory-vm-f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
    'generic-event-before-publish',
    'f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
    'C:\\Mythpen-L1-Control\\directory-f5798c88-ada4-47a0-85dd-a1ed629c5ccb',
  ])
})

test('compares directory arm bindings by exact fields rather than object insertion order', async () => {
  const { assertExactDirectoryBinding } = await import('../windows-l1-vm.mjs')
  const expected = {
    binarySha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), targetTriple: 'x86_64-pc-windows-msvc',
    bunVersion: '1.3.14', sqliteVersion: '3.53.0', sqliteSourceId: 'c'.repeat(64),
    filesystem: { name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' },
  }
  const reordered = {
    filesystem: { rootKind: 'plain-directory', bytesPerSector: 4096, name: 'NTFS' },
    sqliteSourceId: 'c'.repeat(64), sqliteVersion: '3.53.0', bunVersion: '1.3.14',
    targetTriple: 'x86_64-pc-windows-msvc', sourceCommit: 'b'.repeat(40), binarySha256: 'a'.repeat(64),
  }
  assert.doesNotThrow(() => assertExactDirectoryBinding(expected, reordered))
  assert.throws(() => assertExactDirectoryBinding(expected, { ...reordered, binarySha256: 'd'.repeat(64) }), /binding/i)
  assert.throws(() => assertExactDirectoryBinding(expected, {
    ...reordered, filesystem: { ...reordered.filesystem, bytesPerSector: 512 },
  }), /binding/i)
})

test('rejects an activation-aborted cold frame that hides a schema11 activation tail', async () => {
  const { assertDirectoryColdInspection } = await import('../windows-l1-vm.mjs')
  assert.equal(typeof assertDirectoryColdInspection, 'function')
  const current = {
    scenario: 'activation-aborted-before-publish',
    cut: 'controlstore.append.before-publish',
  }
  const arm = { armId: '5a4b73f0-148f-47da-a5ec-6c7512369951', binding: { sourceCommit: 'a'.repeat(40) } }
  const valid = {
    scenario: current.scenario,
    cut: current.cut,
    armId: arm.armId,
    binding: arm.binding,
    convergence: {
      canonical: true,
      kind: 'activation-schema10',
      schemaVersion: 10,
      nativeStateAbsent: true,
      abortedCount: 1,
      activatedCount: 0,
      activationEvents: 2,
      secondReopenStable: true,
    },
    externalVmResetVerified: false,
    capability: false,
  }
  assert.doesNotThrow(() => assertDirectoryColdInspection(current, arm, valid))
  assert.throws(
    () => assertDirectoryColdInspection(current, arm, {
      ...valid,
      convergence: { ...valid.convergence, kind: 'activation', schemaVersion: 11, nativeStateAbsent: false, activatedCount: 1, activationEvents: 4 },
    }),
    /activation-aborted/i,
  )
})

test('records the raw directory cold frame before canonical acceptance', () => {
  const source = readFileSync(new URL('../windows-l1-vm.mjs', import.meta.url), 'utf8')
  const observed = source.indexOf("writeExactJson(join(rowDirectory, 'cold.observed.json'), cold)")
  const acceptance = source.indexOf('assertDirectoryColdInspection(current, armed.frame, cold)')
  assert.ok(observed >= 0 && observed < acceptance)
})

test('terminates the host guestcontrol observer after the VM is externally powered off', async () => {
  const { terminateGuestControlAfterPoweroff } = await import('../windows-l1-vm.mjs')
  for (const killResult of [true, false]) {
    const child = new EventEmitter()
    child.exitCode = null
    child.signalCode = null
    child.killCalls = 0
    child.kill = () => {
      child.killCalls += 1
      queueMicrotask(() => {
        child.exitCode = 1
        child.emit('exit', 1, null)
      })
      return killResult
    }

    await terminateGuestControlAfterPoweroff(child, 100)

    assert.equal(child.killCalls, 1)
    assert.equal(child.exitCode, 1)
  }
})

test('builds target-only cleanup for stale headless frontends after VM poweroff', async () => {
  const { buildExactHeadlessCleanupScript } = await import('../windows-l1-vm.mjs')
  const vmUuid = 'a8f8e55e-e0ad-402f-aba2-ebfc061b0eaa'
  const script = buildExactHeadlessCleanupScript(vmUuid)

  assert.match(script, /Get-CimInstance Win32_Process/)
  assert.match(script, /VBoxHeadless\.exe/)
  assert.match(script, new RegExp(vmUuid, 'i'))
  assert.match(script, /Stop-Process -Id \$target\.ProcessId -Force -ErrorAction SilentlyContinue/)
  assert.doesNotMatch(script, /Stop-Process\s+(?:-Name\s+)?VBoxHeadless/i)
  assert.doesNotMatch(script, /taskkill\s+.*\/IM/i)
})
