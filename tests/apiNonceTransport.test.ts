import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { aiApi, projectsApi } from '../src/lib/api.ts'
import {
  configureBackendRuntimeForTests,
  resetBackendRuntimeForTests,
  type SidecarSession,
} from '../src/lib/backendRuntime.ts'
import { consumeProjectExport, readProjectCover } from '../src/lib/projectExport.ts'
import { forgetProjectInstance, rememberProjectInstance } from '../src/lib/projectInstanceRegistry.ts'

const SESSION: SidecarSession = {
  port: 61234,
  nonce: 'c'.repeat(64),
  childPid: 303,
  buildInfo: {
    nativeActivationMode: 'off',
    sourceCommit: '2'.repeat(40),
    targetTriple: 'x86_64-pc-windows-msvc',
  },
}

type Call = { url: string; headers: Headers; signal: AbortSignal | null; method: string }

function waitForStream(start: (onEnd: () => void, onError: (error: unknown) => void) => void) {
  return new Promise<void>((resolve, reject) => {
    start(resolve, reject)
  })
}

test('JSON, SSE and blob backend requests all share the authenticated transport', async (t) => {
  const project = 'nonce transport project'
  const projectInstance = 'nonce-project-instance'
  const calls: Call[] = []
  t.after(() => {
    forgetProjectInstance(project)
    resetBackendRuntimeForTests()
  })
  rememberProjectInstance(project, projectInstance)

  configureBackendRuntimeForTests({
    mode: 'tauri',
    invoke: async () => SESSION,
    fetch: async (input, init) => {
      const url = String(input)
      calls.push({
        url,
        headers: new Headers(init?.headers),
        signal: init?.signal || null,
        method: init?.method || 'GET',
      })
      if (url.includes('/ai/chat/stream')) {
        return new Response('event: task_end\ndata: {"success":true}\n\n', { status: 200 })
      }
      if (url.includes('/ai/continue') || url.includes('/ai/polish')) {
        return new Response('event: done\ndata: {"success":true}\n\n', { status: 200 })
      }
      if (url.includes('/export?')) {
        return new Response(new Blob(['export']), {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      if (url.includes('/cover')) {
        return new Response(new Blob(['cover']), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
  })

  await projectsApi.getDiagnostics(project)
  await aiApi.chat([], project)
  await waitForStream((onEnd, onError) => aiApi.chatStream([], project, () => {}, onEnd, onError))
  await waitForStream((onEnd, onError) => aiApi.continueWriting(1, '', project, () => {}, onEnd, onError))
  await waitForStream((onEnd, onError) => aiApi.polishChapter(1, project, () => {}, onEnd, onError))
  await consumeProjectExport(project, 'txt', () => undefined)
  await readProjectCover(project)

  assert.equal(calls.length, 7)
  for (const call of calls) {
    assert.match(call.url, /^http:\/\/127\.0\.0\.1:61234\/api\//)
    assert.equal(call.headers.get('X-Mythpen-Instance-Nonce'), SESSION.nonce)
  }
  assert.equal(calls[0].headers.get('X-Mythpen-Project-Instance'), null)
  for (const call of calls.slice(1)) {
    assert.equal(call.headers.get('X-Mythpen-Project-Instance'), projectInstance)
  }
  assert.ok(calls.slice(2, 5).every((call) => call.signal instanceof AbortSignal))
})

test('all remaining local health and AI call sites use backendFetch while GitHub remains external', () => {
  const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8')
  const projectExport = readFileSync(new URL('../src/lib/projectExport.ts', import.meta.url), 'utf8')
  const gate = readFileSync(new URL('../src/components/ServerStatusGate.tsx', import.meta.url), 'utf8')
  const statusbar = readFileSync(new URL('../src/components/BottomStatusbar.tsx', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('../src/components/SettingsDrawer.tsx', import.meta.url), 'utf8')

  for (const source of [api, projectExport, gate, statusbar]) {
    assert.match(source, /backendFetch\(/)
    assert.doesNotMatch(source, /127\.0\.0\.1:3001|\bAPI_BASE\b/)
  }
  assert.match(settings, /backendFetch\('\/ai\/chat'/)
  assert.match(settings, /fetch\('https:\/\/api\.github\.com\//)
  assert.doesNotMatch(settings, /backendFetch\('https:\/\//)
})
