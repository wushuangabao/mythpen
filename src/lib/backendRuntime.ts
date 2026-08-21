export const INSTANCE_NONCE_HEADER = 'X-Mythpen-Instance-Nonce'

export interface SidecarBuildInfo {
  nativeActivationMode: 'off' | 'fixture_only' | 'production'
  sourceCommit: string
  targetTriple: string
  manuscriptLifecycleLease: boolean
  manuscriptChangeNotification: boolean
}

export interface SidecarSession {
  port: number
  nonce: string
  childPid: number
  buildInfo: SidecarBuildInfo
}

type BackendRuntimeMode = 'browser' | 'tauri'
type SessionInvoker = () => Promise<SidecarSession | null>
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface RuntimeOverrides {
  mode: BackendRuntimeMode
  invoke: SessionInvoker
  fetch: Fetcher
}

export class BackendRuntimeUnavailableError extends Error {
  readonly code = 'BACKEND_RUNTIME_UNAVAILABLE'

  constructor() {
    super('Backend runtime is not ready.')
    this.name = 'BackendRuntimeUnavailableError'
  }
}

let overrides: RuntimeOverrides | null = null
let cachedSession: SidecarSession | null = null
let pendingSession: Promise<SidecarSession> | null = null
let sessionGeneration = 0

function runtimeMode(): BackendRuntimeMode {
  if (overrides) return overrides.mode
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window ? 'tauri' : 'browser'
}

function validLowerHex(value: unknown, lengths: number[]): value is string {
  return typeof value === 'string' && lengths.includes(value.length) && /^[0-9a-f]+$/.test(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  return actual.length === required.length && actual.every((key, index) => key === required[index])
}

function isSidecarSession(value: unknown): value is SidecarSession {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const session = value as Record<string, unknown>
  const buildInfo = session.buildInfo
  if (buildInfo === null || typeof buildInfo !== 'object' || Array.isArray(buildInfo)) return false
  const build = buildInfo as Record<string, unknown>
  if (!hasExactKeys(session, ['port', 'nonce', 'childPid', 'buildInfo'])) return false
  if (
    !hasExactKeys(build, [
      'nativeActivationMode',
      'sourceCommit',
      'targetTriple',
      'manuscriptLifecycleLease',
      'manuscriptChangeNotification',
    ])
  )
    return false
  const activationMode = build.nativeActivationMode
  const expectedManuscriptCapability = activationMode === 'production'
  return (
    Number.isInteger(session.port) &&
    Number(session.port) > 0 &&
    Number(session.port) <= 65535 &&
    Number.isSafeInteger(session.childPid) &&
    Number(session.childPid) > 0 &&
    validLowerHex(session.nonce, [64]) &&
    (activationMode === 'off' || activationMode === 'fixture_only' || activationMode === 'production') &&
    validLowerHex(build.sourceCommit, [40, 64]) &&
    typeof build.targetTriple === 'string' &&
    /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_.]+){2,}$/.test(build.targetTriple) &&
    typeof build.manuscriptLifecycleLease === 'boolean' &&
    typeof build.manuscriptChangeNotification === 'boolean' &&
    build.manuscriptLifecycleLease === expectedManuscriptCapability &&
    build.manuscriptChangeNotification === expectedManuscriptCapability
  )
}

async function defaultInvokeSession(): Promise<SidecarSession | null> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<SidecarSession | null>('get_sidecar_session')
}

function invokeSession(): Promise<SidecarSession | null> {
  return overrides ? overrides.invoke() : defaultInvokeSession()
}

function fetchResponse(input: string, init?: RequestInit): Promise<Response> {
  if (overrides) return overrides.fetch(input, init)
  return globalThis.fetch(input, init)
}

async function loadSession(): Promise<SidecarSession> {
  if (cachedSession) return cachedSession
  if (pendingSession) return pendingSession

  const generation = sessionGeneration
  const load = (async () => {
    let candidate: SidecarSession | null
    try {
      candidate = await invokeSession()
    } catch {
      throw new BackendRuntimeUnavailableError()
    }
    if (!isSidecarSession(candidate)) throw new BackendRuntimeUnavailableError()
    if (generation === sessionGeneration) cachedSession = candidate
    return candidate
  })()
  pendingSession = load
  try {
    return await load
  } finally {
    if (generation === sessionGeneration && pendingSession === load) pendingSession = null
  }
}

function validatedPath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new TypeError('Backend path must be API-relative.')
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path.slice(1))) {
    throw new TypeError('Backend path must be API-relative.')
  }
  return path.replace(/\/{2,}/g, '/')
}

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const relativePath = validatedPath(path)
  if (runtimeMode() === 'browser') {
    return fetchResponse(`/api${relativePath}`, init)
  }

  const session = await loadSession()
  const headers = new Headers(init.headers)
  headers.set(INSTANCE_NONCE_HEADER, session.nonce)
  return fetchResponse(`http://127.0.0.1:${session.port}/api${relativePath}`, {
    ...init,
    headers,
  })
}

export function resetBackendSession(): void {
  sessionGeneration++
  cachedSession = null
  pendingSession = null
}

export function configureBackendRuntimeForTests(configuration: RuntimeOverrides): void {
  overrides = configuration
  resetBackendSession()
}

export function resetBackendRuntimeForTests(): void {
  overrides = null
  resetBackendSession()
}
