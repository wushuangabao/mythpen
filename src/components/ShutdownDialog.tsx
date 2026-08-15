import { useEffect, useReducer } from 'react'
import { useT } from '@/hooks/useT'
import { type HostShutdownSnapshot, initialShutdownUiState, reduceShutdownUi } from '@/lib/shutdownUiState'

const SHUTDOWN_EVENT = 'mythpen://shutdown-state'

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function invokeShutdownCommand(command: string): Promise<HostShutdownSnapshot> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<HostShutdownSnapshot>(command)
}

export function ShutdownDialog() {
  const { t } = useT()
  const [state, dispatch] = useReducer(reduceShutdownUi, initialShutdownUiState)

  useEffect(() => {
    if (!isTauriRuntime()) return
    let active = true
    let unlisten: (() => void) | null = null

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<HostShutdownSnapshot>(SHUTDOWN_EVENT, ({ payload }) => {
          if (active) dispatch({ type: 'host_snapshot', snapshot: payload })
        }),
      )
      .then((removeListener) => {
        if (!active) removeListener()
        else unlisten = removeListener
      })
      .catch(() => {
        if (active) dispatch({ type: 'command_failed', code: 'HOST_EVENT_UNAVAILABLE' })
      })

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  if (!state.visible || !isTauriRuntime()) return null

  const run = async (command: string) => {
    try {
      const snapshot = await invokeShutdownCommand(command)
      dispatch({ type: 'host_snapshot', snapshot })
    } catch {
      dispatch({ type: 'command_failed', code: 'HOST_COMMAND_FAILED' })
    }
  }

  const handleContinue = () => {
    dispatch({ type: 'continue_requested' })
    void run('continue_shutdown_wait')
  }
  const handleCancel = () => {
    dispatch({ type: 'cancel_requested' })
    void run('cancel_shutdown')
  }
  const handleEmergency = () => dispatch({ type: 'emergency_requested' })
  const confirmEmergency = () => {
    dispatch({ type: 'emergency_confirmed' })
    void run('emergency_exit')
  }

  const pending = state.pendingAction !== null
  const phase = state.snapshot.phase
  const message =
    phase === 'closing'
      ? t('shutdown.closing')
      : phase === 'soft_deadline'
        ? t('shutdown.softDeadline')
        : phase === 'failed'
          ? t('shutdown.failed', { code: state.snapshot.code || 'UNKNOWN' })
          : phase === 'complete_waiting_for_child'
            ? t('shutdown.waitingForChild')
            : t('shutdown.saving')

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60" role="presentation">
      <div
        className="w-[440px] max-w-[calc(100vw-32px)] rounded-xl border border-[var(--hairline-light)] bg-[var(--canvas-card)] p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shutdown-dialog-title"
      >
        <h2 id="shutdown-dialog-title" className="font-display text-[22px] font-medium text-[var(--ink)]">
          {t('shutdown.title')}
        </h2>
        <p className="mt-3 text-[14px] leading-6 text-[var(--ink-secondary)]">{message}</p>

        {state.emergencyConfirmation ? (
          <div className="mt-5 rounded-lg border border-[var(--error)]/40 bg-[var(--error-soft)] p-4">
            <p className="text-[13px] leading-5 text-[var(--ink)]">{t('shutdown.emergencyWarning')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary h-9 px-4"
                disabled={pending}
                onClick={() => dispatch({ type: 'emergency_confirmation_cancelled' })}
              >
                {t('shutdown.back')}
              </button>
              <button
                type="button"
                className="h-9 rounded-lg border-none bg-[var(--error)] px-4 text-[13px] font-medium text-white disabled:opacity-50"
                disabled={pending}
                onClick={confirmEmergency}
              >
                {t('shutdown.confirmEmergency')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            {state.snapshot.canEmergencyExit && (
              <button type="button" className="btn-secondary h-9 px-4" disabled={pending} onClick={handleEmergency}>
                {t('shutdown.emergencyExit')}
              </button>
            )}
            {state.snapshot.canCancel && phase !== 'closing' && (
              <button type="button" className="btn-secondary h-9 px-4" disabled={pending} onClick={handleCancel}>
                {pending && state.pendingAction === 'cancel' ? t('shutdown.cancelling') : t('shutdown.cancelExit')}
              </button>
            )}
            {state.snapshot.canContinueWaiting && (
              <button type="button" className="btn-primary h-9 px-4" disabled={pending} onClick={handleContinue}>
                {pending && state.pendingAction === 'continue' ? t('shutdown.waiting') : t('shutdown.continueWaiting')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
