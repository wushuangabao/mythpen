import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildProductionSidecar,
  createProductionBuildReceipt,
  compileProductionSidecarArguments,
  compileFixtureOnlySidecarArguments,
  compileSidecarArguments,
  fixtureOnlySidecarOutputPath,
  compileWindowsNativeRollbackProbeArguments,
  compileWindowsNativeDirectoryProbeArguments,
  parseRustcHostTriple,
  parseProductionBuildArguments,
  prepareProductionBuildDestinations,
  productionFilePublisherArguments,
  productionSidecarOutputPath,
  publishProductionBuild,
  sidecarOutputPaths,
  validateBunVersion,
  validateSourceCommit,
  validateTargetTriple,
  windowsNativeRollbackProbeOutputPath,
  windowsNativeDirectoryProbeOutputPath,
} from '../build-sidecars.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function windowsPowerShellSelfTestEnvironment(sourceEnvironment) {
  const childEnvironment = { ...sourceEnvironment }
  for (const key of Object.keys(childEnvironment)) {
    if (key.toLowerCase() === 'psmodulepath') delete childEnvironment[key]
  }
  return childEnvironment
}

function reviewedManifest() {
  return {
    version: 1, type: 'mythpen.windows-l1-reviewed-manifest.v1',
    sourceCommit: 'a'.repeat(40), targetTriple: 'x86_64-pc-windows-msvc',
    runtime: { bunVersion: '1.3.14', sqliteVersion: '3.53.0', sqliteSourceId: 'source-id', sqliteVfs: 'win32' },
    platform: {
      windowsVersion: 'windows-10-enterprise-ltsc-2021-eval-x64',
      filesystem: { name: 'NTFS', bytesPerSector: 4096, rootKind: 'plain-directory' },
      virtualBox: {
        version: '7.2.14', storageController: 'SATA', controller: 'IntelAhci', hostIoCache: false,
      },
    },
    rollbackJournal: { rawRunSha256: 'b'.repeat(64), probeSha256: 'c'.repeat(64), caseCount: 13, complete: true, result: 'all-cold-converged', pragmas: { journalMode: 'delete', synchronous: 3 } },
    directoryEntries: { rawRunSha256: 'd'.repeat(64), probeSha256: 'e'.repeat(64), caseCount: 19, complete: true, result: 'all-cold-converged' },
  }
}

test('production build uses only the production entry and deterministic reviewed-manifest profile defines', () => {
  const sourceCommit = 'a'.repeat(40)
  const triple = 'x86_64-pc-windows-msvc'
  const output = productionSidecarOutputPath('C:\\repo', triple)
  const args = compileProductionSidecarArguments(
    'server/production-sidecar.js', output, sourceCommit, triple, reviewedManifest(),
  )

  assert.match(output, /production-sidecars/)
  assert.doesNotMatch(output, /src-tauri[\\/]binaries/)
  assert.equal(args[0], 'build')
  assert.equal(args[2], 'server/production-sidecar.js')
  assert.ok(args.includes('__MYTHPEN_NATIVE_ACTIVATION_MODE__="production"'))
  assert.ok(args.some((value) => value.startsWith('__MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE_JSON__=')))
  assert.ok(args.some((value) => /^__MYTHPEN_WINDOWS_NATIVE_DURABILITY_AUTHORIZATION_DIGEST__="[0-9a-f]{64}"$/.test(value)))
  assert.doesNotMatch(args.join('\n'), /productionExe|finalExe|candidateExe/i)
  assert.throws(
    () => compileProductionSidecarArguments('server/index.js', output, sourceCommit, triple, reviewedManifest()),
    /only entry/i,
  )
})

test('production build destinations are external create-new siblings with a run-owned staging path', () => {
  const destination = prepareProductionBuildDestinations({
    repositoryRoot: 'C:\\repo',
    l1ManifestPath: 'D:\\evidence\\l1-manifest.json',
    l2ManifestPath: 'D:\\evidence\\l2-manifest.json',
    productionOutputPath: 'D:\\evidence\\candidate.exe',
    productionBuildReceiptPath: 'D:\\evidence\\build-receipt.json',
  }, {
    exists: () => false,
    randomId: () => '0123456789abcdef0123456789abcdef',
  })

  assert.equal(destination.outputPath, 'D:\\evidence\\candidate.exe')
  assert.equal(destination.receiptPath, 'D:\\evidence\\build-receipt.json')
  assert.equal(
    destination.stagingPath,
    'D:\\evidence\\.candidate.exe.0123456789abcdef0123456789abcdef.staging',
  )
  assert.deepEqual(productionFilePublisherArguments('C:\\repo', destination, 'a'.repeat(64)), [
    'C:\\repo\\scripts\\production-evidence-publisher.js',
    'publish-file',
    '--staging',
    destination.stagingPath,
    '--output',
    destination.outputPath,
    '--sha256',
    'a'.repeat(64),
  ])

  assert.throws(() => prepareProductionBuildDestinations({
    repositoryRoot: 'C:\\repo',
    l1ManifestPath: 'D:\\evidence\\l1-manifest.json',
    l2ManifestPath: 'D:\\evidence\\l2-manifest.json',
    productionOutputPath: 'C:\\repo\\src-tauri\\target\\production-sidecars\\candidate.exe',
    productionBuildReceiptPath: 'D:\\evidence\\build-receipt.json',
  }, { exists: () => false }), /external|same directory/i)
  assert.throws(() => prepareProductionBuildDestinations({
    repositoryRoot: 'C:\\repo',
    l1ManifestPath: 'D:\\evidence\\l1-manifest.json',
    l2ManifestPath: 'D:\\evidence\\l2-manifest.json',
    productionOutputPath: 'D:\\evidence\\candidate.exe',
    productionBuildReceiptPath: 'D:\\other\\build-receipt.json',
  }, { exists: () => false }), /same directory/i)
  assert.throws(() => prepareProductionBuildDestinations({
    repositoryRoot: 'C:\\repo',
    l1ManifestPath: 'D:\\evidence\\l1-manifest.json',
    l2ManifestPath: 'D:\\evidence\\l2-manifest.json',
    productionOutputPath: 'D:\\evidence\\candidate.exe',
    productionBuildReceiptPath: 'D:\\evidence\\build-receipt.json',
  }, { exists: (filePath) => filePath.endsWith('candidate.exe') }), /already exists/i)
  assert.throws(() => prepareProductionBuildDestinations({
    repositoryRoot: 'C:\\repo',
    l1ManifestPath: 'D:\\evidence\\l1-manifest.json',
    l2ManifestPath: 'D:\\evidence\\candidate.exe',
    productionOutputPath: 'D:\\evidence\\candidate.exe',
    productionBuildReceiptPath: 'D:\\evidence\\build-receipt.json',
  }, { exists: () => false }), /distinct/i)
  assert.throws(() => prepareProductionBuildDestinations({
    repositoryRoot: 'C:\\repo',
    l1ManifestPath: 'C:\\repo\\l1-manifest.json',
    l2ManifestPath: 'D:\\evidence\\l2-manifest.json',
    productionOutputPath: 'D:\\evidence\\candidate.exe',
    productionBuildReceiptPath: 'D:\\evidence\\build-receipt.json',
  }, { exists: () => false }), /external|same directory/i)
})

test('production build receipt is derived only from bound manifests publication and compiled smoke', () => {
  const sourceCommit = 'a'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  const receipt = createProductionBuildReceipt({
    sourceCommit,
    targetTriple,
    l1Manifest: { path: 'D:\\evidence\\l1-manifest.json', sha256: 'b'.repeat(64) },
    l2Manifest: { path: 'D:\\evidence\\l2-manifest.json', sha256: 'c'.repeat(64) },
    candidatePath: 'D:\\evidence\\candidate.exe',
    publication: {
      bytes: 456,
      identity: { dev: '7', ino: '11' },
      parentFlush: 'complete',
      protocol: 'same-directory-createhardlinkw-v1',
      sha256: 'd'.repeat(64),
      stagingCleanup: 'complete',
    },
    smokeBuildInfo: {
      nativeActivationMode: 'production',
      sourceCommit,
      targetTriple,
      manuscriptLifecycleLease: true,
      manuscriptChangeNotification: true,
    },
  })

  assert.deepEqual(receipt, {
    version: 1,
    type: 'mythpen.windows-production-build-receipt.v1',
    sourceCommit,
    targetTriple,
    l1Manifest: { path: 'D:\\evidence\\l1-manifest.json', sha256: 'b'.repeat(64) },
    l2Manifest: { path: 'D:\\evidence\\l2-manifest.json', sha256: 'c'.repeat(64) },
    candidate: {
      path: 'D:\\evidence\\candidate.exe',
      bytes: 456,
      identity: { dev: '7', ino: '11' },
      sha256: 'd'.repeat(64),
    },
    compiledSmoke: { nativeActivationMode: 'production', sourceCommit, targetTriple },
    protocol: 'same-directory-createhardlinkw-v1',
    stagingCleanup: 'complete',
    parentFlush: 'complete',
  })
  assert.throws(() => createProductionBuildReceipt({
    sourceCommit,
    targetTriple,
    l1Manifest: receipt.l1Manifest,
    l2Manifest: receipt.l2Manifest,
    candidatePath: receipt.candidate.path,
    publication: {
      bytes: receipt.candidate.bytes,
      identity: receipt.candidate.identity,
      parentFlush: receipt.parentFlush,
      protocol: receipt.protocol,
      sha256: receipt.candidate.sha256,
      stagingCleanup: receipt.stagingCleanup,
    },
    smokeBuildInfo: { ...receipt.compiledSmoke, sourceCommit: 'e'.repeat(40) },
  }), /smoke.*binding/i)
})

test('production build CLI requires both manifests external output and receipt exactly once', () => {
  const args = [
    '--production-reviewed-manifest', 'D:\\evidence\\l1.json',
    '--l2-reviewed-manifest', 'D:\\evidence\\l2.json',
    '--production-output', 'D:\\evidence\\candidate.exe',
    '--production-build-receipt', 'D:\\evidence\\receipt.json',
  ]
  assert.deepEqual(parseProductionBuildArguments(args), {
    l1ManifestPath: 'D:\\evidence\\l1.json',
    l2ManifestPath: 'D:\\evidence\\l2.json',
    productionOutputPath: 'D:\\evidence\\candidate.exe',
    productionBuildReceiptPath: 'D:\\evidence\\receipt.json',
  })
  assert.throws(() => parseProductionBuildArguments(args.slice(0, -2)), /arguments/i)
  assert.throws(() => parseProductionBuildArguments([
    ...args,
    '--production-output', 'D:\\evidence\\replacement.exe',
  ]), /arguments/i)
})

test('production build publication is ordered and receipt failure preserves the published candidate', () => {
  const sourceCommit = 'a'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  const destination = {
    l1ManifestPath: 'D:\\evidence\\l1.json',
    l2ManifestPath: 'D:\\evidence\\l2.json',
    outputPath: 'D:\\evidence\\candidate.exe',
    receiptPath: 'D:\\evidence\\receipt.json',
    stagingPath: 'D:\\evidence\\.candidate.exe.0123456789abcdef0123456789abcdef.staging',
  }
  const calls = []
  const input = {
    sourceCommit,
    targetTriple,
    destination,
    l1Manifest: { path: destination.l1ManifestPath, sha256: 'b'.repeat(64) },
    l2Manifest: { path: destination.l2ManifestPath, sha256: 'c'.repeat(64) },
  }
  const dependencies = {
    compile(stagingPath) { calls.push(['compile', stagingPath]) },
    smoke(stagingPath) {
      calls.push(['smoke', stagingPath])
      return {
        nativeActivationMode: 'production', sourceCommit, targetTriple,
        manuscriptLifecycleLease: true, manuscriptChangeNotification: true,
      }
    },
    hash(stagingPath) { calls.push(['hash', stagingPath]); return 'd'.repeat(64) },
    publishFile(request) {
      calls.push(['publish-file', request])
      return {
        bytes: 456,
        identity: { dev: '7', ino: '11' },
        parentFlush: 'complete',
        protocol: 'same-directory-createhardlinkw-v1',
        sha256: request.sha256,
        stagingCleanup: 'complete',
      }
    },
    publishReceipt(request) { calls.push(['publish-receipt', request]) },
    cleanupOwnedStaging(stagingPath) { calls.push(['cleanup-staging', stagingPath]) },
  }

  const result = publishProductionBuild(input, dependencies)
  assert.deepEqual(calls.map(([kind]) => kind), [
    'compile', 'smoke', 'hash', 'publish-file', 'publish-receipt',
  ])
  assert.equal(result.candidate.path, destination.outputPath)
  assert.equal(result.receiptPath, destination.receiptPath)
  assert.equal(calls.some(([kind]) => kind === 'cleanup-staging'), false)

  const failedCalls = []
  assert.throws(() => publishProductionBuild(input, {
    ...dependencies,
    compile() { failedCalls.push('compile') },
    smoke: dependencies.smoke,
    hash: dependencies.hash,
    publishFile(request) { failedCalls.push('publish-file'); return dependencies.publishFile(request) },
    publishReceipt() { failedCalls.push('publish-receipt'); throw new Error('receipt fail') },
    cleanupOwnedStaging() { failedCalls.push('cleanup-staging') },
  }), /receipt fail/)
  assert.deepEqual(failedCalls, ['compile', 'publish-file', 'publish-receipt'])
})

test('production build publication cleans its owned staging only before candidate publication', () => {
  const destination = {
    l1ManifestPath: 'D:\\evidence\\l1.json',
    l2ManifestPath: 'D:\\evidence\\l2.json',
    outputPath: 'D:\\evidence\\candidate.exe',
    receiptPath: 'D:\\evidence\\receipt.json',
    stagingPath: 'D:\\evidence\\.candidate.exe.0123456789abcdef0123456789abcdef.staging',
  }
  const cleaned = []
  assert.throws(() => publishProductionBuild({
    sourceCommit: 'a'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
    destination,
    l1Manifest: { path: destination.l1ManifestPath, sha256: 'b'.repeat(64) },
    l2Manifest: { path: destination.l2ManifestPath, sha256: 'c'.repeat(64) },
  }, {
    compile() {},
    smoke() { throw new Error('smoke fail') },
    hash() { throw new Error('unexpected hash') },
    publishFile() { throw new Error('unexpected publish') },
    publishReceipt() { throw new Error('unexpected receipt') },
    cleanupOwnedStaging(stagingPath) { cleaned.push(stagingPath) },
  }), /smoke fail/)
  assert.deepEqual(cleaned, [destination.stagingPath])
})

test('production build entrypoint compiles only external staging and publishes one bound receipt', () => {
  const sourceCommit = 'a'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  const l1ManifestPath = 'D:\\evidence\\l1.json'
  const l2ManifestPath = 'D:\\evidence\\l2.json'
  const productionOutputPath = 'D:\\evidence\\candidate.exe'
  const productionBuildReceiptPath = 'D:\\evidence\\receipt.json'
  const l1Manifest = reviewedManifest()
  const l2Manifest = { sourceCommit, targetTriple }
  const calls = []
  const result = buildProductionSidecar('C:\\repo', {
    l1ManifestPath,
    l2ManifestPath,
    productionOutputPath,
    productionBuildReceiptPath,
  }, {
    platform: 'win32',
    bunExecutable: 'C:\\tools\\bun.exe',
    exists: () => false,
    randomId: () => '0123456789abcdef0123456789abcdef',
    run(command, args) {
      calls.push(['run', command, args])
      if (command === 'rustc') return `rustc 1.0\nhost: ${targetTriple}\n`
      if (command === 'git') return `${sourceCommit}\n`
      if (command === 'C:\\tools\\bun.exe' && args[0] === '--version') return '1.3.14\n'
      return ''
    },
    readJson(filePath) {
      if (filePath === l1ManifestPath) return l1Manifest
      if (filePath === l2ManifestPath) return l2Manifest
      throw new Error(`unexpected JSON path: ${filePath}`)
    },
    validateL2Manifest(value) { assert.equal(value, l2Manifest) },
    hashFile(filePath) {
      if (filePath === l1ManifestPath) return 'b'.repeat(64)
      if (filePath === l2ManifestPath) return 'c'.repeat(64)
      assert.match(filePath, /\.candidate\.exe\.[0-9a-f]{32}\.staging$/)
      return 'd'.repeat(64)
    },
    smoke(stagingPath) {
      calls.push(['smoke', stagingPath])
      return {
        nativeActivationMode: 'production', sourceCommit, targetTriple,
        manuscriptLifecycleLease: true, manuscriptChangeNotification: true,
      }
    },
    publishFile(request) {
      calls.push(['publish-file', request])
      return {
        bytes: 456,
        identity: { dev: '7', ino: '11' },
        parentFlush: 'complete',
        protocol: 'same-directory-createhardlinkw-v1',
        sha256: request.sha256,
        stagingCleanup: 'complete',
      }
    },
    publishReceipt(request) { calls.push(['publish-receipt', request]) },
    cleanupOwnedStaging(stagingPath) { calls.push(['cleanup-staging', stagingPath]) },
  })

  const compileCall = calls.find(([kind, command, args]) => (
    kind === 'run' && command === 'C:\\tools\\bun.exe' && args[0] === 'build'
  ))
  assert.ok(compileCall)
  const compileOutput = compileCall[2][compileCall[2].indexOf('--outfile') + 1]
  assert.equal(compileOutput, 'D:\\evidence\\.candidate.exe.0123456789abcdef0123456789abcdef.staging')
  assert.doesNotMatch(compileOutput, /src-tauri[\\/]target[\\/]production-sidecars/)
  assert.equal(result.server, productionOutputPath)
  assert.equal(result.buildReceipt, productionBuildReceiptPath)
  const publishedReceipt = calls.find(([kind]) => kind === 'publish-receipt')[1].value
  assert.equal(publishedReceipt.l1Manifest.sha256, 'b'.repeat(64))
  assert.equal(publishedReceipt.l2Manifest.sha256, 'c'.repeat(64))
  assert.equal(publishedReceipt.candidate.sha256, 'd'.repeat(64))
})

test('manuscript capability build-info source contract', () => {
  const sourceCommit = 'a'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  const production = compileProductionSidecarArguments(
    'server/production-sidecar.js',
    'production.exe',
    sourceCommit,
    targetTriple,
    reviewedManifest(),
  )
  const ordinary = compileSidecarArguments(
    'server/index.js', 'ordinary.exe', sourceCommit, targetTriple,
  )
  const fixture = compileFixtureOnlySidecarArguments(
    'server/index.js', 'fixture.exe', sourceCommit, targetTriple,
  )

  for (const capability of [
    '__MYTHPEN_MANUSCRIPT_LIFECYCLE_LEASE__',
    '__MYTHPEN_MANUSCRIPT_CHANGE_NOTIFICATION__',
  ]) {
    assert.ok(production.includes(`${capability}=true`))
    assert.ok(ordinary.includes(`${capability}=false`))
    assert.ok(fixture.includes(`${capability}=false`))
    assert.equal(production.filter((value) => value.startsWith(`${capability}=`)).length, 1)
  }
})

test('Windows PowerShell SelfTest child environment removes every PSModulePath alias only', () => {
  const sourceEnvironment = {
    PATH: 'sentinel-path',
    PSModulePath: 'pwsh-modules',
    PSMODULEPATH: 'upper-modules',
    psmodulepath: 'lower-modules',
    psMODULEpath: 'mixed-modules',
    MYTHPEN_SENTINEL: 'preserved-byte-for-byte',
  }
  const before = { ...sourceEnvironment }

  const childEnvironment = windowsPowerShellSelfTestEnvironment(sourceEnvironment)

  assert.notEqual(childEnvironment, sourceEnvironment)
  assert.deepEqual(sourceEnvironment, before)
  assert.deepEqual(childEnvironment, {
    PATH: 'sentinel-path',
    MYTHPEN_SENTINEL: 'preserved-byte-for-byte',
  })
  assert.equal(
    Object.keys(childEnvironment).some((key) => key.toLowerCase() === 'psmodulepath'),
    false,
  )
})

test('parses the rustc host triple and rejects output without one', () => {
  const output = [
    'rustc 1.88.0 (6b00bc388 2025-06-23)',
    'binary: rustc',
    'host: x86_64-pc-windows-msvc',
    'release: 1.88.0',
  ].join('\n')

  assert.equal(parseRustcHostTriple(output), 'x86_64-pc-windows-msvc')
  assert.throws(() => parseRustcHostTriple('rustc 1.88.0'), /host triple/i)
})

test('uses target-triple sidecar names and only adds exe for Windows targets', () => {
  assert.deepEqual(
    sidecarOutputPaths('C:\\repo', 'x86_64-pc-windows-msvc'),
    {
      server: join('C:\\repo', 'src-tauri', 'binaries', 'mythpen-server-x86_64-pc-windows-msvc.exe'),
      cli: join('C:\\repo', 'src-tauri', 'binaries', 'mythpen-cli-x86_64-pc-windows-msvc.exe'),
    },
  )
  assert.deepEqual(
    sidecarOutputPaths('/repo', 'aarch64-apple-darwin'),
    {
      server: join('/repo', 'src-tauri', 'binaries', 'mythpen-server-aarch64-apple-darwin'),
      cli: join('/repo', 'src-tauri', 'binaries', 'mythpen-cli-aarch64-apple-darwin'),
    },
  )
})

test('fixture-only executable is isolated from installer sidecar binaries', () => {
  const windows = fixtureOnlySidecarOutputPath('C:\\repo', 'x86_64-pc-windows-msvc')
  assert.equal(
    windows,
    join(
      'C:\\repo',
      'src-tauri',
      'target',
      'fixture-sidecars',
      'mythpen-server-fixture-only-x86_64-pc-windows-msvc.exe',
    ),
  )
  assert.doesNotMatch(windows, /src-tauri[\\/]binaries/)
  assert.equal(
    fixtureOnlySidecarOutputPath('/repo', 'aarch64-apple-darwin'),
    join(
      '/repo',
      'src-tauri',
      'target',
      'fixture-sidecars',
      'mythpen-server-fixture-only-aarch64-apple-darwin',
    ),
  )
})

test('Windows rollback capability probe is a fixture-only compiled target outside installer binaries', () => {
  const sourceCommit = 'a'.repeat(40)
  const triple = 'x86_64-pc-windows-msvc'
  const output = windowsNativeRollbackProbeOutputPath('C:\\repo', triple)
  assert.equal(
    output,
    join('C:\\repo', 'src-tauri', 'target', 'capability-probes', `mythpen-native-rollback-probe-${triple}.exe`),
  )
  assert.doesNotMatch(output, /src-tauri[\\/]binaries/)
  assert.deepEqual(
    compileWindowsNativeRollbackProbeArguments(
      'server/testing/windows-native-rollback-probe.js',
      output,
      sourceCommit,
      triple,
    ),
    [
      'build',
      '--compile',
      'server/testing/windows-native-rollback-probe.js',
      '--define',
      `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify(sourceCommit)}`,
      '--define',
      `__MYTHPEN_TARGET_TRIPLE__=${JSON.stringify(triple)}`,
      '--define',
      '__MYTHPEN_NATIVE_ACTIVATION_MODE__="fixture_only"',
      '--define',
      '__MYTHPEN_MANUSCRIPT_LIFECYCLE_LEASE__=false',
      '--define',
      '__MYTHPEN_MANUSCRIPT_CHANGE_NOTIFICATION__=false',
      '--outfile',
      output,
    ],
  )
})

test('Windows directory capability probe is a fixture-only compiled target outside installer binaries', () => {
  const sourceCommit = 'a'.repeat(40)
  const triple = 'x86_64-pc-windows-msvc'
  const output = windowsNativeDirectoryProbeOutputPath('C:\\repo', triple)
  assert.equal(output, join('C:\\repo', 'src-tauri', 'target', 'capability-probes', `mythpen-native-directory-probe-${triple}.exe`))
  assert.doesNotMatch(output, /src-tauri[\\/]binaries/)
  assert.deepEqual(
    compileWindowsNativeDirectoryProbeArguments('server/testing/windows-native-directory-probe.js', output, sourceCommit, triple),
    [
      'build', '--compile', 'server/testing/windows-native-directory-probe.js', '--define',
      `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify(sourceCommit)}`, '--define',
      `__MYTHPEN_TARGET_TRIPLE__=${JSON.stringify(triple)}`, '--define',
      '__MYTHPEN_NATIVE_ACTIVATION_MODE__="fixture_only"', '--define',
      '__MYTHPEN_MANUSCRIPT_LIFECYCLE_LEASE__=false', '--define',
      '__MYTHPEN_MANUSCRIPT_CHANGE_NOTIFICATION__=false', '--outfile', output,
    ],
  )
})

test('requires the reproducible Bun 1.3.14 compiler version', () => {
  assert.doesNotThrow(() => validateBunVersion('1.3.14\n'))
  assert.throws(() => validateBunVersion('1.3.15\n'), /Bun 1\.3\.14/)
})

test('injects only a full source commit and the actual target triple as compile constants', () => {
  const sourceCommit = 'a'.repeat(40)
  const targetTriple = 'x86_64-pc-windows-msvc'
  assert.equal(validateSourceCommit(`${sourceCommit}\n`), sourceCommit)
  assert.equal(validateTargetTriple(targetTriple), targetTriple)
  assert.throws(() => validateSourceCommit('abcdef0\n'), /full source commit/i)
  assert.throws(() => validateSourceCommit(`${'g'.repeat(40)}\n`), /full source commit/i)
  assert.throws(() => validateTargetTriple(''), /target triple/i)

  assert.deepEqual(
    compileSidecarArguments('server/index.js', 'server.exe', sourceCommit, targetTriple),
    [
      'build',
      '--compile',
      'server/index.js',
      '--define',
      `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify(sourceCommit)}`,
      '--define',
      `__MYTHPEN_TARGET_TRIPLE__=${JSON.stringify(targetTriple)}`,
      '--define',
      '__MYTHPEN_NATIVE_ACTIVATION_MODE__="off"',
      '--define',
      '__MYTHPEN_MANUSCRIPT_LIFECYCLE_LEASE__=false',
      '--define',
      '__MYTHPEN_MANUSCRIPT_CHANGE_NOTIFICATION__=false',
      '--outfile',
      'server.exe',
    ],
  )

  assert.deepEqual(
    compileFixtureOnlySidecarArguments(
      'server/index.js',
      'fixture-server.exe',
      sourceCommit,
      targetTriple,
    ),
    [
      'build',
      '--compile',
      'server/index.js',
      '--define',
      `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify(sourceCommit)}`,
      '--define',
      `__MYTHPEN_TARGET_TRIPLE__=${JSON.stringify(targetTriple)}`,
      '--define',
      '__MYTHPEN_NATIVE_ACTIVATION_MODE__="fixture_only"',
      '--define',
      '__MYTHPEN_MANUSCRIPT_LIFECYCLE_LEASE__=false',
      '--define',
      '__MYTHPEN_MANUSCRIPT_CHANGE_NOTIFICATION__=false',
      '--outfile',
      'fixture-server.exe',
    ],
  )
})

test('the shared build path runs an authenticated packaged server smoke', () => {
  const source = readFileSync(join(repositoryRoot, 'scripts', 'build-sidecars.mjs'), 'utf8')
  assert.equal((source.match(/smokeCompiledServer\s*\(/g) || []).length, 3)
  assert.match(source, /MYTHPEN_DESKTOP_OWNED:\s*'1'/)
  assert.match(source, /MYTHPEN_DATA_DIR:/)
  assert.match(source, /MYTHPEN_EXPORT_DIR:/)
  assert.match(source, /type:\s*'build\.info\.request'/)
  assert.match(source, /type:\s*'shutdown\.request'/)
})

test('local Tauri packaging and all CI jobs use the shared sidecar build path with Bun 1.3.14', () => {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  const tauriConfig = JSON.parse(readFileSync(join(repositoryRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'build.yml'), 'utf8')

  assert.equal(packageJson.scripts['build:sidecar'], 'node scripts/build-sidecars.mjs')
  assert.match(tauriConfig.build.beforeBuildCommand, /pnpm build:sidecar/)
  assert.deepEqual(tauriConfig.bundle.externalBin, [
    'binaries/mythpen-server',
    'binaries/mythpen-cli',
  ])
  assert.doesNotMatch(packageJson.scripts['build:sidecar'], /fixture/i)
  assert.doesNotMatch(tauriConfig.build.beforeBuildCommand, /fixture/i)
  assert.doesNotMatch(JSON.stringify(tauriConfig.bundle.externalBin), /fixture/i)
  assert.equal((workflow.match(/run: pnpm build:sidecar/g) || []).length, 0)
  assert.equal((workflow.match(/run: pnpm tauri build(?:\s|$)/g) || []).length, 3)
  assert.equal((workflow.match(/bun-version: 1\.3\.14/g) || []).length, 3)
  assert.doesNotMatch(workflow, /bun build --compile/)
  assert.doesNotMatch(workflow, /\bmv src-tauri\/binaries\/mythpen-/)
})

test('the desktop lifecycle smoke records compiled evidence without hiding unrun branches', () => {
  const smokePath = join(repositoryRoot, 'scripts', 'tests', 'desktop-lifecycle-smoke.ps1')
  const source = readFileSync(smokePath, 'utf8')

  assert.match(source, /MYTHPEN_DESKTOP_LIFECYCLE_SMOKE/)
  assert.match(source, /New-SmokeEnvironment/)
  assert.match(source, /MYTHPEN_DATA_DIR/)
  assert.match(source, /MYTHPEN_EXPORT_DIR/)
  assert.match(source, /WEBVIEW2_USER_DATA_FOLDER/)
  assert.match(source, /com\.mythpen\.desktop/)
  assert.match(source, /fsutil\.exe file queryfileid/)
  assert.match(source, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/)
  assert.match(source, /New-ControlledCdpPortLease/)
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/)
  assert.match(source, /--remote-debugging-port=\$\(\$cdpPortLease\.Port\)/)
  assert.match(source, /Assert-CdpListenerOwnedByDesktopWebView/)
  assert.doesNotMatch(source, /--remote-debugging-port=0/)
  assert.doesNotMatch(source, /DevToolsActivePort/)
  assert.doesNotMatch(source, /Wait-ControlledDevToolsPort/)
  assert.match(source, /IsLoopback/)
  assert.match(source, /MythpenSmokeDesktopCdpUnavailableException/)
  assert.match(source, /EnumWindows/)
  assert.match(source, /GetWindowThreadProcessId/)
  assert.match(source, /GetClassNameW/)
  assert.match(source, /GetWindowTextW/)
  assert.match(source, /MatchesTauriMainWindowIdentity/)
  assert.match(source, /Wait-TauriMainWindow[\s\S]*Get-CdpTarget/)
  assert.match(source, /Assert-DesktopProcessesReadyForCdp[\s\S]*HasExited[\s\S]*IsResponsive/)
  assert.doesNotMatch(source, /\.MainWindowHandle/)
  assert.doesNotMatch(source, /\.Responding/)
  assert.match(source, /Get-CdpTarget[\s\S]*DesktopProcess[\s\S]*OwnedChild/)
  assert.match(source, /\$null = \$socket\.ConnectAsync/)
  assert.match(source, /\$null = \$socket\.SendAsync/)
  assert.match(source, /parent-exit-negative/)
  assert.match(source, /child-exit-negative/)
  assert.match(source, /Get-RemoteDebuggingPolicyEvidence/)
  assert.match(source, /HKCU:\\Software\\Policies\\Microsoft\\Edge/)
  assert.match(source, /HKLM:\\Software\\Policies\\Microsoft\\Edge\\WebView2/)
  assert.match(source, /Add-DesktopNotRunResults/)
  assert.match(source, /catch \[MythpenSmokeDesktopCdpUnavailableException\]/)
  assert.match(source, /Desktop CDP automation unavailable/)
  assert.match(source, /Get-DefaultUserStateSnapshot/)
  assert.match(source, /Compare-DefaultUserStateSnapshots/)
  assert.match(source, /data[\s\S]*control[\s\S]*path_store[\s\S]*webview2[\s\S]*registry/)
  assert.match(source, /default-snapshot-finally-regression/)
  assert.doesNotMatch(source, /Get-FreeLoopbackPort/)
  assert.match(source, /nativeActivationMode/)
  assert.match(source, /sourceCommit/)
  assert.match(source, /targetTriple/)
  assert.match(source, /fake3001/)
  assert.match(source, /wrong_nonce/)
  assert.match(source, /cross_instance_nonce/)
  assert.match(source, /second_instance/)
  assert.match(source, /normal_shutdown/)
  assert.match(source, /continue_wait/)
  assert.match(source, /cancel_shutdown/)
  assert.match(source, /closing_cancel_rejected/)
  assert.match(source, /emergency_exit/)
  assert.match(source, /sentinel_unowned_survived/)
  assert.match(source, /recovery_notice_e2e/)
  assert.match(source, /Invoke-RecoveryNoticeMatrix/)
  assert.match(source, /seed-recovery-notice-scene\.js/)
  assert.match(source, /V1_PUBLICATION_FORWARD_RECOVERABLE/)
  assert.match(source, /PROJECT_WRITE_BUSY/)
  assert.match(source, /aria-live="polite"/)
  assert.match(source, /KeyboardEvent\('keydown'/)
  assert.match(source, /X-Mythpen-Instance-Nonce/)
  assert.match(source, /desktop-emergency[\s\S]*atomicstore\.close\.before-database-close[\s\S]*whenFileExists[\s\S]*MythpenSmokeWindow\]::Close/)
  assert.match(source, /NOT_RUN/)
  assert.match(source, /Assert-SmokeRootSafeForCleanup/)
  assert.match(source, /\[System\.IO\.Path\]::GetFullPath/)
  assert.match(source, /mythpen-desktop-smoke-/)
  assert.match(source, /Wait-RegisterDesktopOwnedChildBeforeSession/)
  assert.match(source, /mythpen-server\.exe/)
  assert.match(source, /Start-DebugDesktop[\s\S]*Wait-RegisterDesktopOwnedChildBeforeSession[\s\S]*Get-CdpTarget/)
  assert.match(source, /function New-DesktopProcess[\s\S]*EnvironmentVariableTarget\]::Process[\s\S]*Start-Process[^\r\n]*-PassThru/)
  assert.match(source, /function Start-DebugDesktop[\s\S]*New-DesktopProcess/)
  assert.doesNotMatch(source, /function Start-DebugDesktop[\s\S]*New-ChildProcess[^\r\n]*-InheritOutput/)
  assert.match(source, /session\.childPid[\s\S]*OwnedChild\.Id/)
  assert.match(source, /prehandshake-cleanup/)
  assert.match(source, /ParentProcessId/)
  assert.match(source, /\.Handle/)
  assert.match(source, /Set-ChildEnvironment/)
  assert.match(source, /MythpenSmokeProcessEnvironment/)
  assert.match(source, /MythpenSmokeProcessEnvironment\]::Set/)
  assert.match(source, /StringDictionary/)
  assert.match(source, /MYTHPEN_SMOKE_CHILD_PROBE/)
  assert.match(source, /RedirectStandardOutput = \$true/)
  assert.match(source, /ReadToEndAsync/)
  assert.match(source, /lastSessionError/)
  assert.match(source, /CDP_PROTOCOL_ERROR/)
  assert.match(source, /Kill\(\)[\s\S]*WaitForExit\(5000\)/)
  assert.match(source, /\/api\/health/)
  assert.match(source, /\/api\/projects/)
  assert.match(source, /\/api\/ai\/chat\/stream/)
  assert.match(source, /\/api\/nonexistent\/cover/)
  assert.match(source, /CONTROL_AUTH_FAILED/)
  assert.match(source, /CONTROL_CANCEL_TOO_LATE/)
  assert.match(source, /CONTROL_INVALID_STATE/)
  assert.match(source, /Get-NonceDigest/)
  assert.match(source, /ready\.childPid[\s\S]*process\.Id/)
  assert.match(source, /buildInfo\.nonceDigest[\s\S]*ready\.nonceDigest/)
  assert.match(source, /desktop-second/)
  assert.match(source, /secondInstanceRootBefore/)
  assert.match(source, /ownerChildSamples/)
  assert.match(source, /MythpenSmokeWindow/)
  assert.match(source, /IsIconic/)
  assert.match(source, /GetForegroundWindow/)
  assert.match(source, /ownerForegroundObserved/)
  assert.match(source, /\$desktop\.WindowHandle/)
  assert.match(source, /desktop-sentinel/)
  assert.match(source, /\[role=dialog\] button:not\(\[disabled\]\)/)
  assert.match(source, /MythpenSmokeWindow\]::Close/)
  assert.doesNotMatch(source, /\.CloseMainWindow\(\)/)
  assert.match(source, /ownedSidecar\.ExitTime/)
  assert.match(source, /desktop\.Process\.ExitTime/)
  assert.match(source, /emergencySidecar\.ExitCode/)
  assert.doesNotMatch(source, /__TAURI_INTERNALS__\.invoke\('(?:request_shutdown|emergency_exit)'\)/)
  assert.match(source, /quiescing[\s\S]*draining[\s\S]*closing[\s\S]*shutdown\.complete/)
  assert.match(source, /Add-SmokeResult 'slow_drain_cancel' 'NOT_RUN'/)
  assert.doesNotMatch(source, /\$StartInfo\.Environment/)
  assert.doesNotMatch(source, /OwnedChildPids/)
  assert.doesNotMatch(source, /Stop-Process/)
  assert.doesNotMatch(source, /Write-(?:Host|Output).*\$nonce/i)

  const mainFinally = source.slice(source.lastIndexOf('} finally {'))
  assert.match(mainFinally, /Get-DefaultUserStateSnapshot/)
  assert.match(mainFinally, /Compare-DefaultUserStateSnapshots/)
  assert.match(mainFinally, /Add-SmokeResult 'cleanup' 'FAIL'/)
})

test('the recovery notice scene seeder creates only an isolated v1 publication fixture', () => {
  const source = readFileSync(join(repositoryRoot, 'scripts', 'tests', 'seed-recovery-notice-scene.js'), 'utf8')

  assert.match(source, /MYTHPEN_RECOVERY_NOTICE_SCENE/)
  assert.match(source, /sqlite\.publish\.prepared/)
  assert.match(source, /ATOMIC_STORE_PUBLISH_BEFORE_REPLACE/)
  assert.match(source, /MYTHPEN_DATA_DIR/)
  assert.doesNotMatch(source, /app\.listen|createApp|recoverV1Publication/)
})

test('production project writes cannot create an event-loop-observable slow drain', async () => {
  const { scanProductionWriteAdmissions } = await import('../assert-production-write-admission.mjs')
  const report = scanProductionWriteAdmissions(repositoryRoot)

  assert.deepEqual(report.asyncAdmissions, [])
  assert.ok(report.syncAdmissions.length > 0)
  assert.deepEqual([...new Set(report.syncAdmissions.map((entry) => entry.file))], [
    'server/db.js',
    'server/native/native-db-adapter.js',
  ])
})

test('the desktop lifecycle smoke SelfTest executes successfully on Windows PowerShell', {
  skip: process.platform !== 'win32' ? 'Windows PowerShell product harness' : false,
  timeout: 35_000,
}, () => {
  const smokePath = join(repositoryRoot, 'scripts', 'tests', 'desktop-lifecycle-smoke.ps1')
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', smokePath,
    '-Mode', 'SelfTest',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: windowsPowerShellSelfTestEnvironment(process.env),
    timeout: 30_000,
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
  const summaryLine = result.stdout.split(/\r?\n/).find((line) => (
    line.startsWith('MYTHPEN_DESKTOP_LIFECYCLE_SMOKE ')
  ))
  assert.ok(summaryLine, result.stdout)
  const summary = JSON.parse(summaryLine.slice('MYTHPEN_DESKTOP_LIFECYCLE_SMOKE '.length))
  assert.equal(summary.mode, 'SelfTest')
  assert.equal(summary.results.find((entry) => entry.name === 'self_test')?.status, 'PASS')
  assert.ok(summary.results.filter((entry) => entry.name !== 'self_test').every((entry) => entry.status === 'NOT_RUN'))
})
