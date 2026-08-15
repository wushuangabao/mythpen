#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  reviewedManifestPath,
) {
  if (process.platform !== 'win32') throw new Error('Production native sidecar requires Windows.')
  if (typeof reviewedManifestPath !== 'string' || reviewedManifestPath.length === 0) {
    throw new Error('An explicit external reviewed manifest path is required.')
  }
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
  let reviewedManifest
  try {
    reviewedManifest = JSON.parse(readFileSync(resolve(reviewedManifestPath), 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read the external reviewed manifest: ${error.message}`)
  }
  run(process.execPath, ['scripts/embed-wasm.mjs'], {
    cwd: repositoryRoot,
    label: 'WASM embedding',
  })
  const server = productionSidecarOutputPath(repositoryRoot, triple)
  mkdirSync(dirname(server), { recursive: true })
  run(bun, compileProductionSidecarArguments(
    'server/production-sidecar.js',
    server,
    sourceCommit,
    triple,
    reviewedManifest,
  ), { cwd: repositoryRoot, label: 'Bun compile (production native server)' })
  smokeCompiledServer({
    executable: server,
    nativeActivationMode: 'production',
    sourceCommit,
    targetTriple: triple,
  })
  return Object.freeze({ server, sourceCommit, triple })
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
    if (process.argv[2] === '--production-reviewed-manifest' && process.argv.length === 4) {
      buildProductionSidecar(
        resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        process.argv[3],
      )
    } else if (process.argv.length === 2) {
      buildSidecars()
    } else {
      throw new Error('Usage: build-sidecars.mjs [--production-reviewed-manifest <external-path>]')
    }
  } catch (error) {
    console.error(`Sidecar build failed: ${error.message}`)
    process.exitCode = 1
  }
}
