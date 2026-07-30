import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseRustcHostTriple,
  sidecarOutputPaths,
  validateBunVersion,
} from '../build-sidecars.mjs'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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

test('requires the reproducible Bun 1.3.14 compiler version', () => {
  assert.doesNotThrow(() => validateBunVersion('1.3.14\n'))
  assert.throws(() => validateBunVersion('1.3.15\n'), /Bun 1\.3\.14/)
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
  assert.equal((workflow.match(/run: pnpm build:sidecar/g) || []).length, 0)
  assert.equal((workflow.match(/run: pnpm tauri build(?:\s|$)/g) || []).length, 3)
  assert.equal((workflow.match(/bun-version: 1\.3\.14/g) || []).length, 3)
  assert.doesNotMatch(workflow, /bun build --compile/)
  assert.doesNotMatch(workflow, /\bmv src-tauri\/binaries\/mythpen-/)
})
