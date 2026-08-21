import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..')
const targetTriple = 'x86_64-pc-windows-msvc'
const sourceCommit = 'f3641a2f0e1da237ce900e04547556f72ae5457e'
const canonicalTempRoot = fs.realpathSync.native(os.tmpdir())
const expectedCandidateSha256 = 'a0cc26f1e442a1e9167914ab0285e8b37c1cc6e3436450aa48413475c30cd04c'
const expectedManifestSha256 = '2caedf0e34b5e45db3ee268deae0e212258e78b8360ac3603a48975ca1309709'
const controlChannel = 'mythpen.sidecar.v1'
const require = createRequire(import.meta.url)
const candidateExecutable = process.env.MYTHPEN_L1_PRODUCTION_CANDIDATE || ''
const reviewedManifestPath = process.env.MYTHPEN_L1_REVIEWED_MANIFEST || ''
const acceptanceTest = candidateExecutable && reviewedManifestPath ? test : test.skip

function runBun(args, options = {}) {
  const result = spawnSync('bun', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    ...options,
  })
  assert.equal(result.error, undefined, result.error?.message)
  return result
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function snapshotTree(root) {
  function visit(current, relative = '') {
    return fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
      .flatMap((entry) => {
        const entryRelative = relative ? path.join(relative, entry.name) : entry.name
        const entryPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          return [{ kind: 'directory', path: entryRelative }, ...visit(entryPath, entryRelative)]
        }
        assert.equal(entry.isFile(), true, `Unexpected non-file evidence entry: ${entryRelative}`)
        const bytes = fs.readFileSync(entryPath)
        return [{ bytes: bytes.length, kind: 'file', path: entryRelative, sha256: sha256(bytes) }]
      })
  }
  return visit(root)
}

function projectMeta(databasePath) {
  const script = [
    "const { Database } = require('bun:sqlite')",
    'const database = new Database(process.argv[1], { create: false, readonly: true, strict: true })',
    "const rows = database.query(\"SELECT key, value FROM project_meta WHERE key IN ('durability_backend','schema_version') ORDER BY key\").all()",
    'database.close()',
    'process.stdout.write(JSON.stringify(rows))',
  ].join(';')
  const result = runBun(['-e', script, databasePath])
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function seedSchemaTenDataRoot(dataRoot) {
  const script = [
    "const db = require('./server/db')",
    'db.configureStorage({ dataDir: process.argv[1] })',
    'await db.initDatabase()',
    "db.createProjectDb('missing-manifest')",
    'db.closeAllDatabases()',
  ].join(';')
  const result = runBun(['-e', script, dataRoot])
  assert.equal(result.status, 0, result.stderr)
  const databasePath = path.join(dataRoot, 'projects', 'missing-manifest.mythpen.db')
  assert.deepEqual(projectMeta(databasePath), [{ key: 'schema_version', value: '10' }])
  return databasePath
}

function compileUnauthorizedProductionSidecar(executable, sourceCommit) {
  const result = runBun([
    'build',
    '--compile',
    'server/production-sidecar.js',
    '--define',
    `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify(sourceCommit)}`,
    '--define',
    `__MYTHPEN_TARGET_TRIPLE__=${JSON.stringify(targetTriple)}`,
    '--define',
    '__MYTHPEN_NATIVE_ACTIVATION_MODE__="production"',
    '--outfile',
    executable,
  ])
  assert.equal(result.status, 0, result.stderr)
}

function waitForFrame(child, type, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs)
    const finish = (error, frame) => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve(frame)
    }
    const onExit = (code) => finish(new Error(`Sidecar exited ${code} before ${type}`))
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch (error) {
          finish(new Error(`Invalid sidecar control frame: ${error.message}: ${line}`))
          return
        }
        if (frame.channel === controlChannel && frame.type === type) {
          finish(null, frame)
          return
        }
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

async function startSidecar(executable, dataRoot, expectedMode) {
  const nonce = randomBytes(32).toString('hex')
  const profile = fs.mkdtempSync(path.join(canonicalTempRoot, 'mythpen-production-profile-'))
  const child = spawn(executable, [], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      APPDATA: path.join(profile, 'AppData', 'Roaming'),
      HOME: profile,
      LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
      MYTHPEN_DATA_DIR: dataRoot,
      MYTHPEN_DESKTOP_OWNED: '1',
      PORT: '0',
      USERPROFILE: profile,
      XDG_CONFIG_HOME: path.join(profile, '.config'),
      XDG_DATA_HOME: path.join(profile, '.local', 'share'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  child.stdin.write(`${JSON.stringify({ channel: controlChannel, type: 'bootstrap', nonce })}\n`)
  try {
    const ready = await waitForFrame(child, 'ready')
    assert.equal(ready.nativeActivationMode, expectedMode)
    assert.equal(ready.sourceCommit, sourceCommit)
    assert.equal(ready.targetTriple, targetTriple)
    const buildInfoPromise = waitForFrame(child, 'build.info')
    child.stdin.write(`${JSON.stringify({
      channel: controlChannel,
      type: 'build.info.request',
      nonce,
    })}\n`)
    const buildInfo = await buildInfoPromise
    assert.equal(buildInfo.nativeActivationMode, expectedMode)
    assert.equal(buildInfo.sourceCommit, sourceCommit)
    assert.equal(buildInfo.targetTriple, targetTriple)
    return { child, nonce, port: ready.port, profile, stderr: () => stderr }
  } catch (error) {
    if (child.exitCode === null) child.kill()
    fs.rmSync(profile, { force: true, recursive: true })
    throw new Error(`${error.message}: ${stderr}`)
  }
}

async function request(session, method, route, body, projectInstance = null) {
  const response = await fetch(`http://127.0.0.1:${session.port}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Mythpen-Instance-Nonce': session.nonce,
      ...(projectInstance === null ? {} : { 'X-Mythpen-Project-Instance': projectInstance }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { payload: await response.json(), status: response.status }
}

async function shutdown(session, attemptSeq = 1) {
  const completePromise = waitForFrame(session.child, 'shutdown.complete')
  session.child.stdin.write(`${JSON.stringify({
    channel: controlChannel,
    type: 'shutdown.request',
    nonce: session.nonce,
    attemptSeq,
  })}\n`)
  const complete = await completePromise
  assert.equal(complete.outcome, 'clean')
  if (session.child.exitCode === null) {
    await new Promise((resolve) => session.child.once('exit', resolve))
  }
  assert.equal(session.child.exitCode, 0, session.stderr())
  fs.rmSync(session.profile, { force: true, recursive: true })
}

function diagnosticStderr(session) {
  return session.stderr().replaceAll(session.nonce, '[REDACTED_NONCE]')
}

function activationEvents(dataRoot) {
  const root = path.join(dataRoot, 'control', 'sqlite')
  if (!fs.existsSync(root)) return []
  const { inspectControlStoreEvidence } = require('../../server/control-store')
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => inspectControlStoreEvidence(path.join(root, entry.name)).events)
    .filter((event) => event.type.startsWith('sqlite.native.activation.'))
}

function assertAttestedInputs() {
  assertFrozenProductionSource()
  assert.equal(fs.existsSync(candidateExecutable), true, 'Attested production candidate is missing')
  assert.equal(fs.existsSync(reviewedManifestPath), true, 'Reviewed manifest is missing')
  assert.equal(sha256(fs.readFileSync(candidateExecutable)), expectedCandidateSha256)
  assert.equal(sha256(fs.readFileSync(reviewedManifestPath)), expectedManifestSha256)
  const manifest = JSON.parse(fs.readFileSync(reviewedManifestPath, 'utf8'))
  assert.equal(manifest.sourceCommit, sourceCommit)
  assert.equal(manifest.targetTriple, targetTriple)
  assert.equal(manifest.platform.filesystem.bytesPerSector, 512)
  return manifest
}

function assertFrozenProductionSource() {
  const allowedTaskFivePaths = [
    ':(exclude)docs/superpowers/plans/l1-windows-production-candidate-acceptance.md',
    ':(exclude)scripts/tests/l1-production-e2e.test.mjs',
  ]
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', sourceCommit, 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(ancestry.error, undefined, ancestry.error?.message)
  assert.equal(ancestry.status, 0, 'The reviewed production source is not an ancestor of HEAD')
  for (const args of [
    ['diff', '--quiet', sourceCommit, 'HEAD', '--', '.', ...allowedTaskFivePaths],
    ['diff', '--quiet', '--', '.', ...allowedTaskFivePaths],
  ]) {
    const diff = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    })
    assert.equal(diff.error, undefined, diff.error?.message)
    assert.equal(diff.status, 0, 'Production source differs from the reviewed source commit')
  }
}

async function createSchemaTenProject(session, name) {
  const created = await request(session, 'POST', '/api/projects', {
    name,
    mode: 'medium-novel',
    language: 'zh',
    genres: ['other'],
  })
  assert.equal(created.status, 200, JSON.stringify(created.payload))
  const instanceId = created.payload.instanceId
  assert.match(instanceId, /^[0-9a-f-]{36}$/)
  const chapter = await request(session, 'POST', `/api/${name}/chapters`, {
    title: '第一章',
  }, instanceId)
  assert.equal(chapter.status, 201, JSON.stringify(chapter.payload))
  const written = await request(session, 'PUT', `/api/${name}/chapters/1`, {
    chapter_id: chapter.payload.id,
    content: 'schema10-before-activation',
    expected_data_version: chapter.payload.data_version,
  }, instanceId)
  assert.equal(written.status, 200, JSON.stringify(written.payload))
  return { chapterId: chapter.payload.id, instanceId }
}

test('RED: compiled production entry without a reviewed manifest fails closed with zero SQLite or activation mutation', { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(canonicalTempRoot, 'mythpen-production-red-'))
  const profile = path.join(root, 'profile')
  const dataRoot = path.join(root, 'data')
  const executable = path.join(root, 'mythpen-production-unauthorized.exe')
  try {
    fs.mkdirSync(profile, { recursive: true })
    const databasePath = seedSchemaTenDataRoot(dataRoot)
    const before = snapshotTree(dataRoot)
    compileUnauthorizedProductionSidecar(executable, sourceCommit)

    const result = spawnSync(executable, [], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        APPDATA: path.join(profile, 'AppData', 'Roaming'),
        HOME: profile,
        LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
        MYTHPEN_DATA_DIR: dataRoot,
        MYTHPEN_DESKTOP_OWNED: '1',
        PORT: '0',
        USERPROFILE: profile,
        XDG_CONFIG_HOME: path.join(profile, '.config'),
        XDG_DATA_HOME: path.join(profile, '.local', 'share'),
      },
      timeout: 30_000,
      windowsHide: true,
    })

    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(
      result.stderr,
      /^Production sidecar startup failed \[DURABILITY_UNSUPPORTED\]: Windows native durability has no exact reviewed build profile\r?\n$/,
    )
    assert.deepEqual(projectMeta(databasePath), [{ key: 'schema_version', value: '10' }])
    assert.deepEqual(snapshotTree(dataRoot), before)
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

acceptanceTest('GREEN: attested compiled production sidecar activates once and retains REST writes across two restarts', { timeout: 180_000 }, async (t) => {
  assertAttestedInputs()
  const root = fs.mkdtempSync(path.join(canonicalTempRoot, 'mythpen-production-green-'))
  const dataRoot = path.join(root, 'data')
  const sessions = []
  t.after(() => {
    for (const session of sessions) {
      if (session.child.exitCode === null) session.child.kill()
      fs.rmSync(session.profile, { force: true, recursive: true })
    }
    fs.rmSync(root, { force: true, recursive: true })
  })

  const first = await startSidecar(candidateExecutable, dataRoot, 'production')
  sessions.push(first)
  const { chapterId, instanceId } = await createSchemaTenProject(first, 'production-e2e')
  const enabled = await request(
    first,
    'POST',
    '/api/projects/by-name/production-e2e/durability/native',
    {},
    instanceId,
  )
  assert.equal(
    enabled.status,
    200,
    `${JSON.stringify(enabled.payload)}\nSTDERR:\n${diagnosticStderr(first)}`,
  )
  assert.deepEqual(enabled.payload, {
    activated: true,
    backend: 'native',
    name: 'production-e2e',
    schemaVersion: 11,
  })
  const activatedRead = await request(
    first,
    'GET',
    `/api/production-e2e/chapters/1?chapter_id=${chapterId}`,
    undefined,
    instanceId,
  )
  assert.equal(activatedRead.status, 200, JSON.stringify(activatedRead.payload))
  assert.equal(activatedRead.payload.content, 'schema10-before-activation')
  const firstNativeWrite = await request(first, 'PUT', '/api/production-e2e/chapters/1', {
    chapter_id: chapterId,
    content: 'native-before-first-restart',
    expected_data_version: activatedRead.payload.data_version,
  }, instanceId)
  assert.equal(firstNativeWrite.status, 200, JSON.stringify(firstNativeWrite.payload))
  await shutdown(first)

  const databasePath = path.join(dataRoot, 'projects', 'production-e2e.mythpen.db')
  assert.deepEqual(projectMeta(databasePath), [
    { key: 'durability_backend', value: 'native-sqlite-v2' },
    { key: 'schema_version', value: '11' },
  ])
  let events = activationEvents(dataRoot)
  assert.deepEqual(events.map((event) => event.type), [
    'sqlite.native.activation.prepared',
    'sqlite.native.activation.activated',
  ])
  assert.equal(events[1].payload.activationId, events[0].payload.activationId)
  assert.equal(events[1].payload.preparedDigest, events[0].digest)

  const second = await startSidecar(candidateExecutable, dataRoot, 'production')
  sessions.push(second)
  const firstRestartRead = await request(
    second,
    'GET',
    `/api/production-e2e/chapters/1?chapter_id=${chapterId}`,
    undefined,
    instanceId,
  )
  assert.equal(firstRestartRead.status, 200, JSON.stringify(firstRestartRead.payload))
  assert.equal(firstRestartRead.payload.content, 'native-before-first-restart')
  const secondNativeWrite = await request(second, 'PUT', '/api/production-e2e/chapters/1', {
    chapter_id: chapterId,
    content: 'native-before-second-restart',
    expected_data_version: firstRestartRead.payload.data_version,
  }, instanceId)
  assert.equal(secondNativeWrite.status, 200, JSON.stringify(secondNativeWrite.payload))
  await shutdown(second)

  const third = await startSidecar(candidateExecutable, dataRoot, 'production')
  sessions.push(third)
  const secondRestartRead = await request(
    third,
    'GET',
    `/api/production-e2e/chapters/1?chapter_id=${chapterId}`,
    undefined,
    instanceId,
  )
  assert.equal(secondRestartRead.status, 200, JSON.stringify(secondRestartRead.payload))
  assert.equal(secondRestartRead.payload.content, 'native-before-second-restart')
  await shutdown(third)

  assert.deepEqual(projectMeta(databasePath), [
    { key: 'durability_backend', value: 'native-sqlite-v2' },
    { key: 'schema_version', value: '11' },
  ])
  events = activationEvents(dataRoot)
  assert.deepEqual(events.map((event) => event.type), [
    'sqlite.native.activation.prepared',
    'sqlite.native.activation.activated',
  ])
  assert.equal(sha256(fs.readFileSync(candidateExecutable)), expectedCandidateSha256)
})

acceptanceTest('off and embedded-profile mismatch controls reject activation with zero SQLite or evidence mutation', { timeout: 180_000 }, async (t) => {
  const manifest = assertAttestedInputs()
  const build = await import('../build-sidecars.mjs')
  const root = fs.mkdtempSync(path.join(canonicalTempRoot, 'mythpen-production-controls-'))
  const dataRoot = path.join(root, 'data')
  const offExecutable = path.join(root, 'mythpen-off-control.exe')
  const mismatchExecutable = path.join(root, 'mythpen-profile-mismatch-control.exe')
  const sessions = []
  t.after(() => {
    for (const session of sessions) {
      if (session.child.exitCode === null) session.child.kill()
      fs.rmSync(session.profile, { force: true, recursive: true })
    }
    fs.rmSync(root, { force: true, recursive: true })
  })

  const offBuild = runBun(build.compileSidecarArguments(
    'server/index.js',
    offExecutable,
    sourceCommit,
    targetTriple,
  ))
  assert.equal(offBuild.status, 0, offBuild.stderr)
  const mismatchArguments = build.compileProductionSidecarArguments(
    'server/production-sidecar.js',
    mismatchExecutable,
    sourceCommit,
    targetTriple,
    manifest,
  )
  const sourceDefine = mismatchArguments.findIndex(
    (argument) => argument.startsWith('__MYTHPEN_SOURCE_COMMIT__='),
  )
  assert.notEqual(sourceDefine, -1)
  mismatchArguments[sourceDefine] = `__MYTHPEN_SOURCE_COMMIT__=${JSON.stringify('0'.repeat(40))}`
  const mismatchBuild = runBun(mismatchArguments)
  assert.equal(mismatchBuild.status, 0, mismatchBuild.stderr)

  const initial = await startSidecar(offExecutable, dataRoot, 'off')
  sessions.push(initial)
  const { instanceId } = await createSchemaTenProject(initial, 'off-control')
  await shutdown(initial)
  const databasePath = path.join(dataRoot, 'projects', 'off-control.mythpen.db')
  assert.deepEqual(projectMeta(databasePath), [{ key: 'schema_version', value: '10' }])

  const off = await startSidecar(offExecutable, dataRoot, 'off')
  sessions.push(off)
  const beforeOff = snapshotTree(dataRoot)
  const rejected = await request(
    off,
    'POST',
    '/api/projects/by-name/off-control/durability/native',
    {},
    instanceId,
  )
  assert.equal(rejected.status, 409, JSON.stringify(rejected.payload))
  assert.equal(rejected.payload.error?.code, 'NATIVE_ACTIVATION_DISABLED')
  assert.deepEqual(projectMeta(databasePath), [{ key: 'schema_version', value: '10' }])
  assert.deepEqual(activationEvents(dataRoot), [])
  assert.deepEqual(snapshotTree(dataRoot), beforeOff)
  await shutdown(off)

  const beforeMismatch = snapshotTree(dataRoot)
  const mismatchProfile = fs.mkdtempSync(path.join(root, 'mismatch-profile-'))
  const mismatch = spawnSync(mismatchExecutable, [], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      APPDATA: path.join(mismatchProfile, 'AppData', 'Roaming'),
      HOME: mismatchProfile,
      LOCALAPPDATA: path.join(mismatchProfile, 'AppData', 'Local'),
      MYTHPEN_DATA_DIR: dataRoot,
      MYTHPEN_DESKTOP_OWNED: '1',
      PORT: '0',
      USERPROFILE: mismatchProfile,
      XDG_CONFIG_HOME: path.join(mismatchProfile, '.config'),
      XDG_DATA_HOME: path.join(mismatchProfile, '.local', 'share'),
    },
    timeout: 30_000,
    windowsHide: true,
  })
  assert.equal(mismatch.error, undefined, mismatch.error?.message)
  assert.equal(mismatch.status, 1)
  assert.equal(mismatch.stdout, '')
  assert.match(
    mismatch.stderr,
    /^Production sidecar startup failed \[DURABILITY_UNSUPPORTED\]: Embedded Windows native durability profile does not match this build\r?\n$/,
  )
  assert.deepEqual(projectMeta(databasePath), [{ key: 'schema_version', value: '10' }])
  assert.deepEqual(activationEvents(dataRoot), [])
  assert.deepEqual(snapshotTree(dataRoot), beforeMismatch)
  assert.equal(sha256(fs.readFileSync(candidateExecutable)), expectedCandidateSha256)
})
