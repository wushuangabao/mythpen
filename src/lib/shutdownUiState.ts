export type HostShutdownPhase =
  | 'idle'
  | 'requesting'
  | 'quiescing'
  | 'draining'
  | 'closing'
  | 'soft_deadline'
  | 'cancelled'
  | 'complete_waiting_for_child'
  | 'failed'
  | 'emergency'

export interface HostShutdownSnapshot {
  attemptSeq: number | null
  phase: HostShutdownPhase
  canContinueWaiting: boolean
  canCancel: boolean
  canEmergencyExit: boolean
  code: string | null
}

export type ShutdownPendingAction = 'continue' | 'cancel' | 'emergency' | null

export interface ShutdownUiState {
  snapshot: HostShutdownSnapshot
  highestAttemptSeq: number
  retiredAttemptSeq: number
  terminalAttemptSeq: number | null
  pendingAction: ShutdownPendingAction
  emergencyConfirmation: boolean
  visible: boolean
}

export type ShutdownUiAction =
  | { type: 'host_snapshot'; snapshot: HostShutdownSnapshot }
  | { type: 'continue_requested' }
  | { type: 'cancel_requested' }
  | { type: 'emergency_requested' }
  | { type: 'emergency_confirmation_cancelled' }
  | { type: 'emergency_confirmed' }
  | { type: 'command_failed'; code: string }

const IDLE_SNAPSHOT: HostShutdownSnapshot = {
  attemptSeq: null,
  phase: 'idle',
  canContinueWaiting: false,
  canCancel: false,
  canEmergencyExit: false,
  code: null,
}

export const initialShutdownUiState: ShutdownUiState = {
  snapshot: IDLE_SNAPSHOT,
  highestAttemptSeq: 0,
  retiredAttemptSeq: 0,
  terminalAttemptSeq: null,
  pendingAction: null,
  emergencyConfirmation: false,
  visible: false,
}

function isTerminal(phase: HostShutdownPhase): boolean {
  return phase === 'failed' || phase === 'emergency' || phase === 'complete_waiting_for_child'
}

function applyHostSnapshot(state: ShutdownUiState, incoming: HostShutdownSnapshot): ShutdownUiState {
  if (incoming.attemptSeq === null) {
    if (incoming.phase !== 'idle' && incoming.phase !== 'cancelled' && incoming.phase !== 'failed') return state
    if (incoming.phase === 'failed') {
      return {
        ...state,
        snapshot: incoming,
        pendingAction: null,
        emergencyConfirmation: false,
        visible: true,
      }
    }
    return {
      ...state,
      snapshot: IDLE_SNAPSHOT,
      retiredAttemptSeq: Math.max(state.retiredAttemptSeq, state.highestAttemptSeq),
      terminalAttemptSeq: null,
      pendingAction: null,
      emergencyConfirmation: false,
      visible: false,
    }
  }

  const attemptSeq = incoming.attemptSeq
  if (!Number.isSafeInteger(attemptSeq) || attemptSeq < 1) return state
  if (attemptSeq <= state.retiredAttemptSeq || attemptSeq < state.highestAttemptSeq) return state
  const newerAttempt = attemptSeq > state.highestAttemptSeq
  if (!newerAttempt && state.terminalAttemptSeq === attemptSeq) {
    if (state.snapshot.phase === incoming.phase) return state
    if (state.snapshot.phase === 'failed' || state.snapshot.phase === 'emergency') return state
    if (state.snapshot.phase === 'complete_waiting_for_child' && incoming.phase !== 'failed') return state
  }

  const duplicatePhase = !newerAttempt && state.snapshot.phase === incoming.phase
  let pendingAction = newerAttempt ? null : state.pendingAction
  let emergencyConfirmation = newerAttempt ? false : state.emergencyConfirmation
  if (!duplicatePhase) {
    if (pendingAction === 'continue' && incoming.phase !== 'soft_deadline') pendingAction = null
    if (pendingAction === 'cancel' && incoming.phase === 'cancelled') pendingAction = null
    if (incoming.phase !== 'soft_deadline') emergencyConfirmation = false
  }

  return {
    ...state,
    snapshot: incoming.phase === 'cancelled' ? IDLE_SNAPSHOT : incoming,
    highestAttemptSeq: Math.max(state.highestAttemptSeq, attemptSeq),
    retiredAttemptSeq:
      incoming.phase === 'cancelled' ? Math.max(state.retiredAttemptSeq, attemptSeq) : state.retiredAttemptSeq,
    terminalAttemptSeq: isTerminal(incoming.phase) ? attemptSeq : newerAttempt ? null : state.terminalAttemptSeq,
    pendingAction: incoming.phase === 'cancelled' ? null : pendingAction,
    emergencyConfirmation: incoming.phase === 'cancelled' ? false : emergencyConfirmation,
    visible: incoming.phase !== 'idle' && incoming.phase !== 'cancelled',
  }
}

export function reduceShutdownUi(state: ShutdownUiState, action: ShutdownUiAction): ShutdownUiState {
  if (action.type === 'host_snapshot') return applyHostSnapshot(state, action.snapshot)
  if (action.type === 'continue_requested') {
    if (state.snapshot.phase !== 'soft_deadline' || !state.snapshot.canContinueWaiting || state.pendingAction)
      return state
    return { ...state, pendingAction: 'continue', emergencyConfirmation: false }
  }
  if (action.type === 'cancel_requested') {
    if (!state.snapshot.canCancel || state.snapshot.phase === 'closing' || state.pendingAction) return state
    return { ...state, pendingAction: 'cancel', emergencyConfirmation: false }
  }
  if (action.type === 'emergency_requested') {
    if (!state.snapshot.canEmergencyExit || state.pendingAction) return state
    return { ...state, emergencyConfirmation: true }
  }
  if (action.type === 'emergency_confirmation_cancelled') {
    return { ...state, emergencyConfirmation: false }
  }
  if (action.type === 'emergency_confirmed') {
    if (!state.emergencyConfirmation || !state.snapshot.canEmergencyExit || state.pendingAction) return state
    return { ...state, emergencyConfirmation: false, pendingAction: 'emergency' }
  }
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      phase: 'failed',
      canContinueWaiting: false,
      canCancel: true,
      canEmergencyExit: true,
      code: action.code,
    },
    terminalAttemptSeq: state.snapshot.attemptSeq,
    pendingAction: null,
    emergencyConfirmation: false,
    visible: true,
  }
}
