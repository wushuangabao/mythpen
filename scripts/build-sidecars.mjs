#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WINDOWS_PRODUCTION_BUILD_RECEIPT_TYPE,
  canonicalJsonBytes,
  validateL2ReviewedManifest,
} from './production-evidence-publisher.js'

const REQUIRED_BUN_VERSION = '1.3.14'
const require = createRequire(import.meta.url)
const {
  createWindowsNativeDurabilityBuildAuthorization,
} = require('../server/platform/windows-native-durability-profile')

export function parseRustcHostTriple(output) {
  const match = String(output).match(/^host:\s*(\S+)\s*$/m)
  if (!match) {
    throw new Error('Unable to determine the Rust host triple from `rustc -vV` output.')
  }
  return match[1]
}

export function validateBunVersion(output) {
  const version = String(output).trim()
  if (version !== REQUIRED_BUN_VERSION) {
    throw new Error(`Bun ${REQUIRED_BUN_VERSION} is required; found ${version || 'unknown'}.`)
  }
}

export function validateSourceCommit(output) {
  const sourceCommit = String(output).trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    throw new Error('Unable to determine a full source commit from `git rev-parse HEAD`.')
  }
  return sourceCommit
}

export function validateTargetTriple(value) {
  const targetTriple = String(value).trim()
  if (!/^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/.test(targetTriple)) {
    throw new Error('Unable to determine a valid target triple.')
  }
  return targetTriple
}

function compileSidecarArgumentsForMode(entry, output, sourceCommit, targetTriple, mode) {
  const manuscriptCapability = mode === 'production'
  return [
    'build',
    '--compile',
    entry,
    '--define',
    `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify(validateSourceCommit(sourceCommit))}`,
    '--define',
    `__MYTHPEN_TARGET_TRIPLE__=${JSON.stringify(validateTargetTriple(targetTriple))}`,
    '--define',
    `__MYTHPEN_NATIVE_ACTIVATION_MODE__=${JSON.stringify(mode)}`,
    '--define',
    `__MYTHPEN_MANUSCRIPT_LIFECYCLE_LEASE__=${manuscriptCapability}`,
    '--define',
    `__MYTHPEN_MANUSCRIPT_CHANGE_NOTIFICATION__=${manuscriptCapability}`,
    '--outfile',
    output,
  ]
}

export function compileSidecarArguments(entry, output, sourceCommit, targetTriple) {
  return compileSidecarArgumentsForMode(entry, output, sourceCommit, targetTriple, 'off')
}

export function compileFixtureOnlySidecarArguments(entry, output, sourceCommit, targetTriple) {
  return compileSidecarArgumentsForMode(
    entry,
    output,
    sourceCommit,
    targetTriple,
    'fixture_only',
  )
}

export function compileProductionSidecarArguments(
  entry,
  output,
  sourceCommit,
  targetTriple,
  reviewedManifest,
) {
  if (String(entry).replaceAll('\\', '/') !== 'server/production-sidecar.js') {
    throw new Error('Production native builds require server/production-sidecar.js as the only entry.')
  }
  const validatedSourceCommit = validateSourceCommit(sourceCommit)
  const validatedTargetTriple = validateTargetTriple(targetTriple)
  const authorization = createWindowsNativeDurabilityBuildAuthorization(reviewedManifest, {
    sourceCommit: validatedSourceCommit,
    targetTriple: validatedTargetTriple,
  })
  const args = compileSidecarArgumentsForMode(
    entry,
    output,
    validatedSourceCommit,
    validatedTargetTriple,
    'production',
  )
  args.splice(-2, 0,
    '--define',
    `__MYTHPEN_WINDOWS_NATIVE_DURABILITY_PROFILE_JSON__=${JSON.stringify(authorization.profileJson)}`,
    '--define',
    `__MYTHPEN_WINDOWS_NATIVE_DURABILITY_AUTHORIZATION_DIGEST__=${JSON.stringify(authorization.authorizationDigest)}`,
  )
  return args
}

function resolveBunExecutable() {
  const pathEntries = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')
  for (const pathEntry of pathEntries) {
    if (!pathEntry) continue
    const directExecutable = join(pathEntry, process.platform === 'win32' ? 'bun.exe' : 'bun')
    if (existsSync(directExecutable)) return directExecutable

    if (process.platform === 'win32') {
      const npmInstalledExecutable = join(pathEntry, 'node_modules', 'bun', 'bin', 'bun.exe')
      if (existsSync(npmInstalledExecutable)) return npmInstalledExecutable
    }
  }
  return 'bun'
}

function prepareBunExecutable(bun, repositoryRoot) {
  if (process.platform !== 'win32' || /^[\x00-\x7F]*$/.test(bun)) return bun

  const cachedBun = join(repositoryRoot, 'src-tauri', 'target', 'bun-runtime', 'bun.exe')
  mkdirSync(dirname(cachedBun), { recursive: true })
  copyFileSync(bun, cachedBun)
  return cachedBun
}

export function sidecarOutputPaths(repositoryRoot, triple) {
  const extension = /-windows(?:-|$)/.test(triple) ? '.exe' : ''
  const binaries = join(repositoryRoot, 'src-tauri', 'binaries')
  return {
    server: join(binaries, `mythpen-server-${triple}${extension}`),
    cli: join(binaries, `mythpen-cli-${triple}${extension}`),
  }
}

export function fixtureOnlySidecarOutputPath(repositoryRoot, triple) {
  const extension = /-windows(?:-|$)/.test(triple) ? '.exe' : ''
  return join(
    repositoryRoot,
    'src-tauri',
    'target',
    'fixture-sidecars',
    `mythpen-server-fixture-only-${triple}${extension}`,
  )
}

export function productionSidecarOutputPath(repositoryRoot, triple) {
  if (validateTargetTriple(triple) !== 'x86_64-pc-windows-msvc') {
    throw new Error('Production native sidecar requires x86_64-pc-windows-msvc.')
  }
  return join(
    repositoryRoot,
    'src-tauri',
    'target',
    'production-sidecars',
    `mythpen-server-production-${triple}.exe`,
  )
}

function exactAbsoluteBuildPath(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || !isAbsolute(value)
    || resolve(value) !== value
  ) throw new Error(`${label} must be one normalized absolute path.`)
  return value
}

function isWithin(root, candidate) {
  const relation = relative(root, candidate)
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
}

export function prepareProductionBuildDestinations({
  repositoryRoot,
  l1ManifestPath,
  l2ManifestPath,
  productionOutputPath,
  productionBuildReceiptPath,
}, overrides = {}) {
  const root = exactAbsoluteBuildPath(repositoryRoot, 'repositoryRoot')
  const outputPath = exactAbsoluteBuildPath(productionOutputPath, 'productionOutputPath')
  const receiptPath = exactAbsoluteBuildPath(
    productionBuildReceiptPath,
    'productionBuildReceiptPath',
  )
  const l1Path = exactAbsoluteBuildPath(l1ManifestPath, 'l1ManifestPath')
  const l2Path = exactAbsoluteBuildPath(l2ManifestPath, 'l2ManifestPath')
  const parent = dirname(outputPath)
  const evidencePaths = [outputPath, receiptPath, l1Path, l2Path]
  if (
    new Set(evidencePaths).size !== evidencePaths.length
    || [receiptPath, l1Path, l2Path].some((filePath) => dirname(filePath) !== parent)
  ) throw new Error('Production evidence paths must be distinct files in the same directory.')
  if (evidencePaths.some((filePath) => isWithin(root, filePath))) {
    throw new Error('Production build evidence must be external to the repository.')
  }
  const randomId = (overrides.randomId ?? (() => randomBytes(16).toString('hex')))()
  if (!/^[0-9a-f]{32}$/.test(randomId)) throw new Error('Production build run identity is invalid.')
  const stagingPath = join(parent, `.${basename(outputPath)}.${randomId}.staging`)
  const exists = overrides.exists ?? existsSync
  for (const finalPath of [outputPath, receiptPath, stagingPath]) {
    if (exists(finalPath)) throw new Error(`Production build destination already exists: ${finalPath}`)
  }
  return Object.freeze({
    l1ManifestPath: l1Path,
    l2ManifestPath: l2Path,
    outputPath,
    receiptPath,
    stagingPath,
  })
}

export function productionFilePublisherArguments(repositoryRoot, destination, sha256) {
  const root = exactAbsoluteBuildPath(repositoryRoot, 'repositoryRoot')
  if (!/^[0-9a-f]{64}$/.test(sha256 || '')) throw new Error('Candidate SHA-256 is invalid.')
  return [
    join(root, 'scripts', 'production-evidence-publisher.js'),
    'publish-file',
    '--staging',
    exactAbsoluteBuildPath(destination?.stagingPath, 'stagingPath'),
    '--output',
    exactAbsoluteBuildPath(destination?.outputPath, 'outputPath'),
    '--sha256',
    sha256,
  ]
}

export function parseProductionBuildArguments(args) {
  if (!Array.isArray(args) || args.length !== 8) {
    throw new Error('Invalid production build arguments.')
  }
  const allowed = new Set([
    '--production-reviewed-manifest',
    '--l2-reviewed-manifest',
    '--production-output',
    '--production-build-receipt',
  ])
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!allowed.has(flag) || Object.hasOwn(values, flag) || typeof value !== 'string' || value.length === 0) {
      throw new Error('Invalid production build arguments.')
    }
    values[flag] = value
  }
  if (Object.keys(values).length !== allowed.size) throw new Error('Invalid production build arguments.')
  return {
    l1ManifestPath: values['--production-reviewed-manifest'],
    l2ManifestPath: values['--l2-reviewed-manifest'],
    productionOutputPath: values['--production-output'],
    productionBuildReceiptPath: values['--production-build-receipt'],
  }
}

function exactArtifactReference(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'path,sha256'
    || !/^[0-9a-f]{64}$/.test(value.sha256 || '')
  ) throw new Error(`${label} reference is inexact.`)
  return Object.freeze({
    path: exactAbsoluteBuildPath(value.path, `${label} path`),
    sha256: value.sha256,
  })
}

export function createProductionBuildReceipt({
  sourceCommit,
  targetTriple,
  l1Manifest,
  l2Manifest,
  candidatePath,
  publication,
  smokeBuildInfo,
}) {
  const source = validateSourceCommit(sourceCommit)
  const triple = validateTargetTriple(targetTriple)
  if (
    smokeBuildInfo?.nativeActivationMode !== 'production'
    || smokeBuildInfo.sourceCommit !== source
    || smokeBuildInfo.targetTriple !== triple
    || smokeBuildInfo.manuscriptLifecycleLease !== true
    || smokeBuildInfo.manuscriptChangeNotification !== true
  ) throw new Error('Compiled smoke binding is inexact.')
  if (
    !Number.isSafeInteger(publication?.bytes)
    || publication.bytes <= 0
    || !/^[0-9a-f]{64}$/.test(publication.sha256 || '')
    || publication?.identity === null
    || typeof publication?.identity !== 'object'
    || Array.isArray(publication.identity)
    || Object.keys(publication.identity).sort().join(',') !== 'dev,ino'
    || typeof publication.identity.dev !== 'string'
    || typeof publication.identity.ino !== 'string'
    || publication.protocol !== 'same-directory-createhardlinkw-v1'
    || publication.stagingCleanup !== 'complete'
    || publication.parentFlush !== 'complete'
  ) throw new Error('Candidate publication receipt is inexact.')
  return Object.freeze({
    version: 1,
    type: WINDOWS_PRODUCTION_BUILD_RECEIPT_TYPE,
    sourceCommit: source,
    targetTriple: triple,
    l1Manifest: exactArtifactReference(l1Manifest, 'L1 manifest'),
    l2Manifest: exactArtifactReference(l2Manifest, 'L2 manifest'),
    candidate: Object.freeze({
      path: exactAbsoluteBuildPath(candidatePath, 'candidatePath'),
      bytes: publication.bytes,
      identity: Object.freeze({ ...publication.identity }),
      sha256: publication.sha256,
    }),
    compiledSmoke: Object.freeze({
      nativeActivationMode: 'production',
      sourceCommit: source,
      targetTriple: triple,
    }),
    protocol: publication.protocol,
    stagingCleanup: publication.stagingCleanup,
    parentFlush: publication.parentFlush,
  })
}

export function publishProductionBuild({
  sourceCommit,
  targetTriple,
  destination,
  l1Manifest,
  l2Manifest,
}, dependencies) {
  for (const operation of [
    'compile', 'smoke', 'hash', 'publishFile', 'publishReceipt', 'cleanupOwnedStaging',
  ]) {
    if (typeof dependencies?.[operation] !== 'function') {
      throw new Error(`Production build dependency is missing: ${operation}`)
    }
  }
  let candidatePublished = false
  try {
    dependencies.compile(destination.stagingPath)
    const smokeBuildInfo = dependencies.smoke(destination.stagingPath)
    const candidateSha256 = dependencies.hash(destination.stagingPath)
    let publication
    try {
      publication = dependencies.publishFile({
        stagingPath: destination.stagingPath,
        outputPath: destination.outputPath,
        sha256: candidateSha256,
      })
      candidatePublished = true
    } catch (error) {
      candidatePublished = error?.published === true
      throw error
    }
    const receipt = createProductionBuildReceipt({
      sourceCommit,
      targetTriple,
      l1Manifest,
      l2Manifest,
      candidatePath: destination.outputPath,
      publication,
      smokeBuildInfo,
    })
    dependencies.publishReceipt({ outputPath: destination.receiptPath, value: receipt })
    return Object.freeze({ ...receipt, receiptPath: destination.receiptPath })
  } catch (error) {
    if (!candidatePublished) {
      try {
        dependencies.cleanupOwnedStaging(destination.stagingPath)
      } catch (cleanupError) {
        error.stagingCleanupError = cleanupError
      }
    }
    throw error
  }
}

function hashFileContents(filePath) {
  const hash = createHash('sha256')
  const handle = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    closeSync(handle)
  }
  return hash.digest('hex')
}

function inspectPublishedCandidate(filePath) {
  const stats = lstatSync(filePath, { bigint: true })
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Published production candidate is not a plain file.')
  }
  return {
    bytes: Number(stats.size),
    identity: { dev: String(stats.dev), ino: String(stats.ino) },
    links: Number(stats.nlink),
    sha256: hashFileContents(filePath),
  }
}

function compiledSmokeBuildInfo(smokeResult) {
  const buildInfo = smokeResult?.frames?.find((frame) => frame.type === 'build.info')
  if (!buildInfo) throw new Error('Production compiled smoke did not return build info.')
  return buildInfo
}

function publishReceiptWithPublisher({
  bun,
  repositoryRoot,
  outputPath,
  value,
  runCommand,
}) {
  const payloadPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${randomBytes(16).toString('hex')}.payload`,
  )
  writeFileSync(payloadPath, canonicalJsonBytes(value), { flag: 'wx', mode: 0o600 })
  let primaryError = null
  try {
    runCommand(bun, [
      join(repositoryRoot, 'scripts', 'production-evidence-publisher.js'),
      'publish-json',
      '--profile',
      'production-build-receipt',
      '--input',
      payloadPath,
      '--output',
      outputPath,
    ], { cwd: repositoryRoot, label: 'Production build receipt publication' })
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      if (existsSync(payloadPath)) unlinkSync(payloadPath)
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError
      primaryError.payloadCleanupError = cleanupError
    }
  }
}

export function windowsNativeRollbackProbeOutputPath(repositoryRoot, triple) {
  if (validateTargetTriple(triple) !== 'x86_64-pc-windows-msvc') {
    throw new Error('Windows native rollback probe requires x86_64-pc-windows-msvc.')
  }
  return join(
    repositoryRoot,
    'src-tauri',
    'target',
    'capability-probes',
    `mythpen-native-rollback-probe-${triple}.exe`,
  )
}

export function windowsNativeDirectoryProbeOutputPath(repositoryRoot, triple) {
  if (validateTargetTriple(triple) !== 'x86_64-pc-windows-msvc') {
    throw new Error('Windows native directory probe requires x86_64-pc-windows-msvc.')
  }
  return join(repositoryRoot, 'src-tauri', 'target', 'capability-probes', `mythpen-native-directory-probe-${triple}.exe`)
}

export function compileWindowsNativeRollbackProbeArguments(entry, output, sourceCommit, targetTriple) {
  return compileSidecarArgumentsForMode(entry, output, sourceCommit, targetTriple, 'fixture_only')
}

export function compileWindowsNativeDirectoryProbeArguments(entry, output, sourceCommit, targetTriple) {
  return compileSidecarArgumentsForMode(entry, output, sourceCommit, targetTriple, 'fixture_only')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${options.label || command} is unavailable on PATH.`)
  }
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : ''
    throw new Error(
      `${options.label || command} failed with exit code ${result.status}${detail ? `: ${detail}` : '.'}`,
    )
  }
  return result.stdout || ''
}

function parseSmokeFrames(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter(Boolean)
  return lines.map((line) => {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      throw new Error(`Packaged sidecar wrote non-NDJSON stdout: ${line.slice(0, 120)}`)
    }
    if (frame?.channel !== 'mythpen.sidecar.v1') {
      throw new Error('Packaged sidecar wrote an unexpected control channel frame.')
    }
    return frame
  })
}

export function smokeCompiledServer({
  executable,
  nativeActivationMode = 'off',
  sourceCommit,
  targetTriple,
}) {
  const smokeRoot = mkdtempSync(join(tmpdir(), 'mythpen-sidecar-smoke-'))
  const profileRoot = join(smokeRoot, 'profile')
  const dataRoot = join(smokeRoot, 'data')
  const exportRoot = join(smokeRoot, 'exports')
  const nonce = randomBytes(32).toString('hex')
  const input = [
    { channel: 'mythpen.sidecar.v1', type: 'bootstrap', nonce },
    { channel: 'mythpen.sidecar.v1', type: 'build.info.request', nonce },
    { channel: 'mythpen.sidecar.v1', type: 'shutdown.request', nonce, attemptSeq: 1 },
  ].map((frame) => JSON.stringify(frame)).join('\n') + '\n'
  let primaryError = null
  try {
    const result = spawnSync(executable, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APPDATA: join(profileRoot, 'AppData', 'Roaming'),
        HOME: profileRoot,
        LOCALAPPDATA: join(profileRoot, 'AppData', 'Local'),
        MYTHPEN_DATA_DIR: dataRoot,
        MYTHPEN_DESKTOP_OWNED: '1',
        MYTHPEN_EXPORT_DIR: exportRoot,
        PORT: '0',
        USERPROFILE: profileRoot,
        XDG_CONFIG_HOME: join(profileRoot, '.config'),
        XDG_DATA_HOME: join(profileRoot, '.local', 'share'),
      },
      input,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim()
      throw new Error(`Packaged server smoke failed with exit code ${result.status}${detail ? `: ${detail}` : '.'}`)
    }
    if (String(result.stdout).includes(nonce) || String(result.stderr).includes(nonce)) {
      throw new Error('Packaged sidecar exposed its raw instance nonce.')
    }
    const frames = parseSmokeFrames(result.stdout)
    const ready = frames.find((frame) => frame.type === 'ready')
    const buildInfo = frames.find((frame) => frame.type === 'build.info')
    const complete = frames.find((frame) => frame.type === 'shutdown.complete')
    const expected = {
      nativeActivationMode,
      sourceCommit: validateSourceCommit(sourceCommit),
      targetTriple: validateTargetTriple(targetTriple),
      manuscriptLifecycleLease: nativeActivationMode === 'production',
      manuscriptChangeNotification: nativeActivationMode === 'production',
    }
    const nonceDigest = createHash('sha256').update(Buffer.from(nonce, 'hex')).digest('hex')
    if (!ready || ready.host !== '127.0.0.1' || !Number.isSafeInteger(ready.port) || ready.port < 1) {
      throw new Error('Packaged sidecar did not report a valid dynamic loopback ready frame.')
    }
    for (const frame of [ready, buildInfo]) {
      if (!frame
        || frame.nativeActivationMode !== expected.nativeActivationMode
        || frame.sourceCommit !== expected.sourceCommit
        || frame.targetTriple !== expected.targetTriple
        || frame.manuscriptLifecycleLease !== expected.manuscriptLifecycleLease
        || frame.manuscriptChangeNotification !== expected.manuscriptChangeNotification
        || frame.nonceDigest !== nonceDigest) {
        throw new Error('Packaged sidecar build metadata did not match the compiled target.')
      }
    }
    if (complete?.attemptSeq !== 1 || complete?.outcome !== 'clean') {
      throw new Error('Packaged sidecar did not complete authenticated graceful shutdown.')
    }
    return { frames, smokeRoot }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      rmSync(smokeRoot, { force: true, recursive: true })
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError
      try {
        Object.defineProperty(primaryError, 'smokeCleanupError', { value: cleanupError })
      } catch {
        // Keep the primary build/smoke failure.
      }
    }
  }
}

export function buildSidecars(repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const bun = prepareBunExecutable(resolveBunExecutable(), repositoryRoot)
  const rustcOutput = run('rustc', ['-vV'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'rustc',
  })
  const triple = validateTargetTriple(parseRustcHostTriple(rustcOutput))
  const sourceCommit = validateSourceCommit(run('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'git',
  }))
  const bunVersion = run(bun, ['--version'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'Bun',
  })
  validateBunVersion(bunVersion)

  run(process.execPath, ['scripts/embed-wasm.mjs'], {
    cwd: repositoryRoot,
    label: 'WASM embedding',
  })

  const outputs = sidecarOutputPaths(repositoryRoot, triple)
  mkdirSync(dirname(outputs.server), { recursive: true })
  for (const [entry, output] of [
    ['server/index.js', outputs.server],
    ['server/cli.js', outputs.cli],
  ]) {
    run(bun, compileSidecarArguments(entry, output, sourceCommit, triple), {
      cwd: repositoryRoot,
      label: `Bun compile (${entry})`,
    })
  }

  smokeCompiledServer({
    executable: outputs.server,
    sourceCommit,
    targetTriple: triple,
  })

  console.log(`Built sidecars for ${triple}:`)
  console.log(`- ${outputs.server}`)
  console.log(`- ${outputs.cli}`)
  return { sourceCommit, triple, ...outputs }
}

export function buildFixtureOnlySidecar(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const bun = prepareBunExecutable(resolveBunExecutable(), repositoryRoot)
  const triple = validateTargetTriple(parseRustcHostTriple(run('rustc', ['-vV'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'rustc',
  })))
  const sourceCommit = validateSourceCommit(run('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'git',
  }))
  validateBunVersion(run(bun, ['--version'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'Bun',
  }))
  run(process.execPath, ['scripts/embed-wasm.mjs'], {
    cwd: repositoryRoot,
    label: 'WASM embedding',
  })

  const server = fixtureOnlySidecarOutputPath(repositoryRoot, triple)
  mkdirSync(dirname(server), { recursive: true })
  run(
    bun,
    compileFixtureOnlySidecarArguments(
      'server/testing/fixture-only-sidecar.js',
      server,
      sourceCommit,
      triple,
    ),
    { cwd: repositoryRoot, label: 'Bun compile (fixture-only server)' },
  )
  return Object.freeze({ server, sourceCommit, triple })
}

export function buildProductionSidecar(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  options,
  overrides = {},
) {
  const platform = overrides.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Production native sidecar requires Windows.')
  const destination = prepareProductionBuildDestinations({ repositoryRoot, ...options }, overrides)
  const runCommand = overrides.run ?? run
  const bun = overrides.bunExecutable
    ?? prepareBunExecutable(resolveBunExecutable(), repositoryRoot)
  const triple = validateTargetTriple(parseRustcHostTriple(runCommand('rustc', ['-vV'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'rustc',
  })))
  const sourceCommit = validateSourceCommit(runCommand('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'git',
  }))
  validateBunVersion(runCommand(bun, ['--version'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'Bun',
  }))
  const readJson = overrides.readJson ?? ((filePath) => JSON.parse(readFileSync(filePath, 'utf8')))
  let l1Manifest
  let l2Manifest
  try {
    l1Manifest = readJson(destination.l1ManifestPath)
    l2Manifest = readJson(destination.l2ManifestPath)
  } catch (error) {
    throw new Error(`Unable to read the external reviewed manifests: ${error.message}`)
  }
  const compileArguments = compileProductionSidecarArguments(
    'server/production-sidecar.js',
    destination.stagingPath,
    sourceCommit,
    triple,
    l1Manifest,
  )
  const validateL2Manifest = overrides.validateL2Manifest ?? validateL2ReviewedManifest
  validateL2Manifest(l2Manifest)
  if (l2Manifest?.sourceCommit !== sourceCommit || l2Manifest?.targetTriple !== triple) {
    throw new Error('L2 reviewed manifest does not bind the production source and target.')
  }
  const hashFile = overrides.hashFile ?? hashFileContents
  const l1ManifestReference = Object.freeze({
    path: destination.l1ManifestPath,
    sha256: hashFile(destination.l1ManifestPath),
  })
  const l2ManifestReference = Object.freeze({
    path: destination.l2ManifestPath,
    sha256: hashFile(destination.l2ManifestPath),
  })
  runCommand(process.execPath, ['scripts/embed-wasm.mjs'], {
    cwd: repositoryRoot,
    label: 'WASM embedding',
  })
  const smoke = overrides.smoke ?? ((stagingPath) => compiledSmokeBuildInfo(smokeCompiledServer({
    executable: stagingPath,
    nativeActivationMode: 'production',
    sourceCommit,
    targetTriple: triple,
  })))
  const publication = publishProductionBuild({
    sourceCommit,
    targetTriple: triple,
    destination,
    l1Manifest: l1ManifestReference,
    l2Manifest: l2ManifestReference,
  }, {
    compile() {
      runCommand(bun, compileArguments, {
        cwd: repositoryRoot,
        label: 'Bun compile (production native server staging)',
      })
    },
    smoke,
    hash: hashFile,
    publishFile: overrides.publishFile ?? ((request) => {
      try {
        runCommand(bun, productionFilePublisherArguments(
          repositoryRoot,
          { stagingPath: request.stagingPath, outputPath: request.outputPath },
          request.sha256,
        ), { cwd: repositoryRoot, label: 'Production candidate publication' })
      } catch (error) {
        if (existsSync(request.outputPath)) error.published = true
        throw error
      }
      const facts = inspectPublishedCandidate(request.outputPath)
      if (facts.links !== 1 || facts.sha256 !== request.sha256) {
        const error = new Error('Published production candidate facts are inexact.')
        error.published = true
        throw error
      }
      return {
        bytes: facts.bytes,
        identity: facts.identity,
        parentFlush: 'complete',
        protocol: 'same-directory-createhardlinkw-v1',
        sha256: facts.sha256,
        stagingCleanup: 'complete',
      }
    }),
    publishReceipt: overrides.publishReceipt ?? ((request) => publishReceiptWithPublisher({
      bun,
      repositoryRoot,
      outputPath: request.outputPath,
      value: request.value,
      runCommand,
    })),
    cleanupOwnedStaging: overrides.cleanupOwnedStaging ?? ((stagingPath) => {
      if (existsSync(stagingPath)) unlinkSync(stagingPath)
    }),
  })
  return Object.freeze({
    server: destination.outputPath,
    buildReceipt: destination.receiptPath,
    candidate: publication.candidate,
    sourceCommit,
    triple,
  })
}

export function buildWindowsNativeRollbackProbe(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  if (process.platform !== 'win32') throw new Error('Windows native rollback probe requires Windows.')
  const bun = prepareBunExecutable(resolveBunExecutable(), repositoryRoot)
  const triple = validateTargetTriple(parseRustcHostTriple(run('rustc', ['-vV'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'rustc',
  })))
  const sourceCommit = validateSourceCommit(run('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'git',
  }))
  validateBunVersion(run(bun, ['--version'], { cwd: repositoryRoot, capture: true, label: 'Bun' }))
  const probe = windowsNativeRollbackProbeOutputPath(repositoryRoot, triple)
  mkdirSync(dirname(probe), { recursive: true })
  run(bun, compileWindowsNativeRollbackProbeArguments(
    'server/testing/windows-native-rollback-probe.js', probe, sourceCommit, triple,
  ), { cwd: repositoryRoot, label: 'Bun compile (Windows native rollback probe)' })
  return Object.freeze({ probe, sourceCommit, triple })
}

export function buildWindowsNativeDirectoryProbe(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
) {
  if (process.platform !== 'win32') throw new Error('Windows native directory probe requires Windows.')
  const bun = prepareBunExecutable(resolveBunExecutable(), repositoryRoot)
  const triple = validateTargetTriple(parseRustcHostTriple(run('rustc', ['-vV'], { cwd: repositoryRoot, capture: true, label: 'rustc' })))
  const sourceCommit = validateSourceCommit(run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, capture: true, label: 'git' }))
  validateBunVersion(run(bun, ['--version'], { cwd: repositoryRoot, capture: true, label: 'Bun' }))
  const probe = windowsNativeDirectoryProbeOutputPath(repositoryRoot, triple)
  mkdirSync(dirname(probe), { recursive: true })
  run(bun, compileWindowsNativeDirectoryProbeArguments('server/testing/windows-native-directory-probe.js', probe, sourceCommit, triple), {
    cwd: repositoryRoot, label: 'Bun compile (Windows native directory probe)',
  })
  return Object.freeze({ probe, sourceCommit, triple, entry: 'server/testing/windows-native-directory-probe.js', nativeActivationMode: 'fixture_only' })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) {
      buildProductionSidecar(
        resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        parseProductionBuildArguments(process.argv.slice(2)),
      )
    } else if (process.argv.length === 2) {
      buildSidecars()
    } else {
      throw new Error(
        'Usage: build-sidecars.mjs [--production-reviewed-manifest <path> --l2-reviewed-manifest <path> --production-output <path> --production-build-receipt <path>]',
      )
    }
  } catch (error) {
    console.error(`Sidecar build failed: ${error.message}`)
    process.exitCode = 1
  }
}
