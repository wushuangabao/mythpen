#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_BUN_VERSION = '1.3.14'

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

export function sidecarOutputPaths(repositoryRoot, triple) {
  const extension = /-windows(?:-|$)/.test(triple) ? '.exe' : ''
  const binaries = join(repositoryRoot, 'src-tauri', 'binaries')
  return {
    server: join(binaries, `mythpen-server-${triple}${extension}`),
    cli: join(binaries, `mythpen-cli-${triple}${extension}`),
  }
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

export function buildSidecars(repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const rustcOutput = run('rustc', ['-vV'], {
    cwd: repositoryRoot,
    capture: true,
    label: 'rustc',
  })
  const triple = parseRustcHostTriple(rustcOutput)
  const bunVersion = run('bun', ['--version'], {
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
    run('bun', ['build', '--compile', entry, '--outfile', output], {
      cwd: repositoryRoot,
      label: `Bun compile (${entry})`,
    })
  }

  console.log(`Built sidecars for ${triple}:`)
  console.log(`- ${outputs.server}`)
  console.log(`- ${outputs.cli}`)
  return { triple, ...outputs }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    buildSidecars()
  } catch (error) {
    console.error(`Sidecar build failed: ${error.message}`)
    process.exitCode = 1
  }
}
