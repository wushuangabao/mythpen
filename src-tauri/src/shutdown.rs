use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ShutdownPhase {
    Idle,
    Requesting,
    Quiescing,
    Draining,
    Closing,
    SoftDeadline,
    CompleteWaitingForChild,
    Failed,
    Emergency,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostShutdownSnapshot {
    pub(crate) attempt_seq: Option<u64>,
    pub(crate) phase: ShutdownPhase,
    pub(crate) can_continue_waiting: bool,
    pub(crate) can_cancel: bool,
    pub(crate) can_emergency_exit: bool,
    pub(crate) code: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HostShutdownEffect {
    None,
    SendRequest { attempt_seq: u64 },
    SendCancel { attempt_seq: u64 },
    SendContinueWait { attempt_seq: u64 },
    KillOwnedChild,
    ExitApp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleInput {
    MainWindowCloseRequested,
    ExitRequested,
    Exit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LifecycleMapping {
    PreventCloseAndBeginOrReplay,
    PreventExitAndBeginOrReplay,
    AllowExit,
    CleanupOnly,
}

pub(crate) fn map_tauri_lifecycle(input: LifecycleInput, allow_app_exit: bool) -> LifecycleMapping {
    match (input, allow_app_exit) {
        (LifecycleInput::MainWindowCloseRequested, false) => {
            LifecycleMapping::PreventCloseAndBeginOrReplay
        }
        (LifecycleInput::ExitRequested, false) => LifecycleMapping::PreventExitAndBeginOrReplay,
        (LifecycleInput::ExitRequested, true) => LifecycleMapping::AllowExit,
        (LifecycleInput::Exit, _) => LifecycleMapping::CleanupOnly,
        (LifecycleInput::MainWindowCloseRequested, true) => LifecycleMapping::AllowExit,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ActiveAttempt {
    attempt_seq: u64,
    server_phase: ShutdownPhase,
    cancel_pending: bool,
    complete_seen: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct HostShutdownError {
    code: &'static str,
}

impl HostShutdownError {
    pub(crate) fn code(self) -> &'static str {
        self.code
    }
}

pub(crate) struct HostShutdown {
    owned_child_pid: u32,
    last_accepted_attempt: u64,
    active: Option<ActiveAttempt>,
    phase: ShutdownPhase,
    code: Option<String>,
    allow_app_exit: bool,
    emergency: bool,
}

impl HostShutdown {
    pub(crate) fn new(owned_child_pid: u32) -> Self {
        Self {
            owned_child_pid,
            last_accepted_attempt: 0,
            active: None,
            phase: ShutdownPhase::Idle,
            code: None,
            allow_app_exit: false,
            emergency: false,
        }
    }

    pub(crate) fn request(
        &mut self,
        session_ready: bool,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if self.emergency || self.allow_app_exit {
            return Err(HostShutdownError {
                code: "SHUTDOWN_INVALID_STATE",
            });
        }
        if !session_ready {
            self.phase = ShutdownPhase::Failed;
            self.code = Some("SIDECAR_STARTUP_NOT_READY".to_owned());
            return Ok(HostShutdownEffect::None);
        }
        if let Some(active) = self.active {
            return Ok(HostShutdownEffect::SendRequest {
                attempt_seq: active.attempt_seq,
            });
        }
        let attempt_seq = self
            .last_accepted_attempt
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or(HostShutdownError {
                code: "SHUTDOWN_ATTEMPT_EXHAUSTED",
            })?;
        self.last_accepted_attempt = attempt_seq;
        self.active = Some(ActiveAttempt {
            attempt_seq,
            server_phase: ShutdownPhase::Requesting,
            cancel_pending: false,
            complete_seen: false,
        });
        self.phase = ShutdownPhase::Requesting;
        self.code = None;
        Ok(HostShutdownEffect::SendRequest { attempt_seq })
    }

    pub(crate) fn on_state(
        &mut self,
        child_pid: u32,
        attempt_seq: u64,
        phase: ShutdownPhase,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if !matches!(
            phase,
            ShutdownPhase::Quiescing | ShutdownPhase::Draining | ShutdownPhase::Closing
        ) {
            return Err(HostShutdownError {
                code: "SHUTDOWN_PROTOCOL_INVALID_STATE",
            });
        }
        if matches!(
            self.phase,
            ShutdownPhase::CompleteWaitingForChild
                | ShutdownPhase::Failed
                | ShutdownPhase::Emergency
        ) {
            return Ok(HostShutdownEffect::None);
        }
        let Some(active) = self.active.as_mut() else {
            return Ok(HostShutdownEffect::None);
        };
        if child_pid != self.owned_child_pid || attempt_seq != active.attempt_seq {
            return Ok(HostShutdownEffect::None);
        }
        let valid_progression = matches!(
            (active.server_phase, phase),
            (ShutdownPhase::Requesting, ShutdownPhase::Quiescing)
                | (ShutdownPhase::Requesting, ShutdownPhase::Draining)
                | (ShutdownPhase::Quiescing, ShutdownPhase::Quiescing)
                | (ShutdownPhase::Quiescing, ShutdownPhase::Draining)
                | (ShutdownPhase::Draining, ShutdownPhase::Draining)
                | (ShutdownPhase::Draining, ShutdownPhase::Closing)
                | (ShutdownPhase::Closing, ShutdownPhase::Closing)
        );
        if !valid_progression {
            return Err(HostShutdownError {
                code: "SHUTDOWN_PROTOCOL_INVALID_STATE",
            });
        }
        active.server_phase = phase;
        self.phase = phase;
        Ok(HostShutdownEffect::None)
    }

    pub(crate) fn on_soft_deadline(
        &mut self,
        child_pid: u32,
        attempt_seq: u64,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if matches!(
            self.phase,
            ShutdownPhase::Closing
                | ShutdownPhase::CompleteWaitingForChild
                | ShutdownPhase::Failed
                | ShutdownPhase::Emergency
        ) {
            return Ok(HostShutdownEffect::None);
        }
        let Some(active) = self.active else {
            return Ok(HostShutdownEffect::None);
        };
        if child_pid != self.owned_child_pid || attempt_seq != active.attempt_seq {
            return Ok(HostShutdownEffect::None);
        }
        self.phase = ShutdownPhase::SoftDeadline;
        Ok(HostShutdownEffect::None)
    }

    pub(crate) fn continue_wait(&mut self) -> Result<HostShutdownEffect, HostShutdownError> {
        let active = self.active.ok_or(HostShutdownError {
            code: "SHUTDOWN_INVALID_STATE",
        })?;
        if self.phase != ShutdownPhase::SoftDeadline {
            return Err(HostShutdownError {
                code: "SHUTDOWN_INVALID_STATE",
            });
        }
        self.phase = active.server_phase;
        Ok(HostShutdownEffect::SendContinueWait {
            attempt_seq: active.attempt_seq,
        })
    }

    pub(crate) fn cancel(&mut self) -> Result<HostShutdownEffect, HostShutdownError> {
        if self.active.is_none() && self.phase == ShutdownPhase::Failed {
            self.phase = ShutdownPhase::Idle;
            self.code = None;
            return Ok(HostShutdownEffect::None);
        }
        let active = self.active.as_mut().ok_or(HostShutdownError {
            code: "SHUTDOWN_INVALID_STATE",
        })?;
        if !matches!(
            self.phase,
            ShutdownPhase::Quiescing | ShutdownPhase::Draining | ShutdownPhase::SoftDeadline
        ) || active.server_phase == ShutdownPhase::Closing
            || active.complete_seen
        {
            return Err(HostShutdownError {
                code: "SHUTDOWN_CANCEL_TOO_LATE",
            });
        }
        active.cancel_pending = true;
        Ok(HostShutdownEffect::SendCancel {
            attempt_seq: active.attempt_seq,
        })
    }

    pub(crate) fn on_cancelled(
        &mut self,
        child_pid: u32,
        attempt_seq: u64,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if matches!(
            self.phase,
            ShutdownPhase::CompleteWaitingForChild
                | ShutdownPhase::Failed
                | ShutdownPhase::Emergency
        ) {
            return Ok(HostShutdownEffect::None);
        }
        let Some(active) = self.active else {
            return Ok(HostShutdownEffect::None);
        };
        if child_pid != self.owned_child_pid || attempt_seq != active.attempt_seq {
            return Ok(HostShutdownEffect::None);
        }
        if !active.cancel_pending
            || !matches!(
                self.phase,
                ShutdownPhase::Quiescing | ShutdownPhase::Draining | ShutdownPhase::SoftDeadline
            )
        {
            return Err(HostShutdownError {
                code: "SHUTDOWN_PROTOCOL_INVALID_STATE",
            });
        }
        self.active = None;
        self.phase = ShutdownPhase::Idle;
        self.code = None;
        Ok(HostShutdownEffect::None)
    }

    pub(crate) fn on_complete(
        &mut self,
        child_pid: u32,
        attempt_seq: u64,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if matches!(self.phase, ShutdownPhase::Failed | ShutdownPhase::Emergency) {
            return Ok(HostShutdownEffect::None);
        }
        let Some(active) = self.active.as_mut() else {
            return Ok(HostShutdownEffect::None);
        };
        if child_pid != self.owned_child_pid || attempt_seq != active.attempt_seq {
            return Ok(HostShutdownEffect::None);
        }
        if active.server_phase != ShutdownPhase::Closing {
            return Err(HostShutdownError {
                code: "SHUTDOWN_PROTOCOL_INVALID_STATE",
            });
        }
        active.complete_seen = true;
        self.phase = ShutdownPhase::CompleteWaitingForChild;
        Ok(HostShutdownEffect::None)
    }

    pub(crate) fn on_failed(
        &mut self,
        child_pid: u32,
        attempt_seq: u64,
        code: &str,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if matches!(
            self.phase,
            ShutdownPhase::CompleteWaitingForChild | ShutdownPhase::Emergency
        ) {
            return Ok(HostShutdownEffect::None);
        }
        let Some(active) = self.active else {
            return Ok(HostShutdownEffect::None);
        };
        if child_pid != self.owned_child_pid || attempt_seq != active.attempt_seq {
            return Ok(HostShutdownEffect::None);
        }
        self.phase = ShutdownPhase::Failed;
        self.code = Some(code.to_owned());
        Ok(HostShutdownEffect::None)
    }

    pub(crate) fn fail_current(&mut self, code: &str) {
        if self.allow_app_exit || self.emergency {
            return;
        }
        self.phase = ShutdownPhase::Failed;
        self.code = Some(code.to_owned());
    }

    pub(crate) fn on_terminated(
        &mut self,
        child_pid: u32,
        code: Option<i32>,
        signal: Option<i32>,
    ) -> Result<HostShutdownEffect, HostShutdownError> {
        if child_pid != self.owned_child_pid {
            return Ok(HostShutdownEffect::None);
        }
        if self.emergency {
            self.allow_app_exit = true;
            return Ok(HostShutdownEffect::ExitApp);
        }
        let clean = self.active.is_some_and(|active| active.complete_seen)
            && code == Some(0)
            && signal.is_none();
        if clean {
            self.allow_app_exit = true;
            return Ok(HostShutdownEffect::ExitApp);
        }
        self.phase = ShutdownPhase::Failed;
        self.code = Some("SIDECAR_TERMINATED".to_owned());
        Ok(HostShutdownEffect::None)
    }

    pub(crate) fn emergency_exit(&mut self) -> Result<HostShutdownEffect, HostShutdownError> {
        if !matches!(
            self.phase,
            ShutdownPhase::SoftDeadline | ShutdownPhase::Failed
        ) {
            return Err(HostShutdownError {
                code: "SHUTDOWN_EMERGENCY_NOT_ALLOWED",
            });
        }
        self.emergency = true;
        self.phase = ShutdownPhase::Emergency;
        self.code = None;
        Ok(HostShutdownEffect::KillOwnedChild)
    }

    pub(crate) fn allow_app_exit(&self) -> bool {
        self.allow_app_exit
    }

    pub(crate) fn snapshot(&self) -> HostShutdownSnapshot {
        let active = self.active;
        HostShutdownSnapshot {
            attempt_seq: active.map(|attempt| attempt.attempt_seq),
            phase: self.phase,
            can_continue_waiting: self.phase == ShutdownPhase::SoftDeadline,
            can_cancel: (active.is_some()
                && matches!(
                    self.phase,
                    ShutdownPhase::Quiescing
                        | ShutdownPhase::Draining
                        | ShutdownPhase::SoftDeadline
                ))
                || (active.is_none() && self.phase == ShutdownPhase::Failed),
            can_emergency_exit: matches!(
                self.phase,
                ShutdownPhase::SoftDeadline | ShutdownPhase::Failed
            ),
            code: self.code.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        map_tauri_lifecycle, HostShutdown, HostShutdownEffect, LifecycleInput, LifecycleMapping,
        ShutdownPhase,
    };

    const PID: u32 = 4242;

    fn reach_closing(host: &mut HostShutdown) {
        host.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        host.on_state(PID, 1, ShutdownPhase::Closing).unwrap();
    }

    #[test]
    fn lifecycle_mapper_prevents_close_and_exit_until_host_allows_exit() {
        assert_eq!(
            map_tauri_lifecycle(LifecycleInput::MainWindowCloseRequested, false),
            LifecycleMapping::PreventCloseAndBeginOrReplay
        );
        assert_eq!(
            map_tauri_lifecycle(LifecycleInput::ExitRequested, false),
            LifecycleMapping::PreventExitAndBeginOrReplay
        );
        assert_eq!(
            map_tauri_lifecycle(LifecycleInput::ExitRequested, true),
            LifecycleMapping::AllowExit
        );
        assert_eq!(
            map_tauri_lifecycle(LifecycleInput::Exit, false),
            LifecycleMapping::CleanupOnly
        );
    }

    #[test]
    fn first_request_is_one_and_active_request_replays_same_attempt() {
        let mut host = HostShutdown::new(PID);
        assert_eq!(
            host.request(true).unwrap(),
            HostShutdownEffect::SendRequest { attempt_seq: 1 }
        );
        assert_eq!(
            host.request(true).unwrap(),
            HostShutdownEffect::SendRequest { attempt_seq: 1 }
        );
    }

    #[test]
    fn active_request_does_not_replay_after_the_session_becomes_unavailable() {
        let mut host = HostShutdown::new(PID);
        host.request(true).unwrap();

        assert_eq!(host.request(false).unwrap(), HostShutdownEffect::None);
        assert_eq!(host.snapshot().phase, ShutdownPhase::Failed);
        assert_eq!(
            host.snapshot().code.as_deref(),
            Some("SIDECAR_STARTUP_NOT_READY")
        );
    }

    #[test]
    fn cancellation_fences_stale_frames_and_next_request_increments_once() {
        let mut host = HostShutdown::new(PID);
        host.request(true).unwrap();
        host.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        assert_eq!(
            host.cancel().unwrap(),
            HostShutdownEffect::SendCancel { attempt_seq: 1 }
        );
        host.on_cancelled(PID, 1).unwrap();
        assert_eq!(host.snapshot().phase, ShutdownPhase::Idle);

        host.on_state(PID, 1, ShutdownPhase::Closing).unwrap();
        assert_eq!(host.snapshot().phase, ShutdownPhase::Idle);
        assert_eq!(
            host.request(true).unwrap(),
            HostShutdownEffect::SendRequest { attempt_seq: 2 }
        );
    }

    #[test]
    fn closing_disables_cancel_and_ignores_soft_deadline() {
        let mut host = HostShutdown::new(PID);
        host.request(true).unwrap();
        host.on_state(PID, 1, ShutdownPhase::Quiescing).unwrap();
        host.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        host.on_state(PID, 1, ShutdownPhase::Closing).unwrap();
        assert!(host.cancel().is_err());
        assert!(host.on_soft_deadline(PID, 1).is_ok());
        assert_eq!(host.snapshot().phase, ShutdownPhase::Closing);
        assert!(!host.snapshot().can_cancel);
    }

    #[test]
    fn clean_complete_waits_for_matching_normal_child_termination() {
        let mut host = HostShutdown::new(PID);
        host.request(true).unwrap();
        reach_closing(&mut host);
        host.on_complete(PID, 1).unwrap();
        assert_eq!(
            host.snapshot().phase,
            ShutdownPhase::CompleteWaitingForChild
        );
        assert!(!host.allow_app_exit());

        assert_eq!(
            host.on_terminated(PID, Some(0), None).unwrap(),
            HostShutdownEffect::ExitApp
        );
        assert!(host.allow_app_exit());
    }

    #[test]
    fn complete_is_rejected_until_the_matching_attempt_reaches_closing() {
        for phase in [
            ShutdownPhase::Requesting,
            ShutdownPhase::Quiescing,
            ShutdownPhase::Draining,
        ] {
            let mut host = HostShutdown::new(PID);
            host.request(true).unwrap();
            if phase == ShutdownPhase::Quiescing {
                host.on_state(PID, 1, ShutdownPhase::Quiescing).unwrap();
            } else if phase == ShutdownPhase::Draining {
                host.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
            }

            assert!(host.on_complete(PID, 1).is_err());
            assert_eq!(host.snapshot().phase, phase);
            assert!(!host.allow_app_exit());
        }
    }

    #[test]
    fn early_or_abnormal_termination_is_failed_not_clean() {
        let mut early = HostShutdown::new(PID);
        early.request(true).unwrap();
        assert_eq!(
            early.on_terminated(PID, Some(0), None).unwrap(),
            HostShutdownEffect::None
        );
        assert_eq!(early.snapshot().phase, ShutdownPhase::Failed);
        assert!(!early.allow_app_exit());

        let mut abnormal = HostShutdown::new(PID);
        abnormal.request(true).unwrap();
        reach_closing(&mut abnormal);
        abnormal.on_complete(PID, 1).unwrap();
        abnormal.on_terminated(PID, Some(1), None).unwrap();
        assert_eq!(abnormal.snapshot().phase, ShutdownPhase::Failed);
        assert!(!abnormal.allow_app_exit());
    }

    #[test]
    fn emergency_is_explicit_and_consumes_only_owned_handle_without_graceful_frame() {
        let mut host = HostShutdown::new(PID);
        host.request(false).unwrap();
        assert_eq!(host.snapshot().phase, ShutdownPhase::Failed);
        assert_eq!(
            host.emergency_exit().unwrap(),
            HostShutdownEffect::KillOwnedChild
        );
        assert_eq!(host.snapshot().phase, ShutdownPhase::Emergency);
        assert!(!host.allow_app_exit());
    }

    #[test]
    fn emergency_is_rejected_outside_soft_deadline_or_failed() {
        let mut idle = HostShutdown::new(PID);
        assert!(idle.emergency_exit().is_err());

        let mut requesting = HostShutdown::new(PID);
        requesting.request(true).unwrap();
        assert!(requesting.emergency_exit().is_err());

        let mut quiescing = HostShutdown::new(PID);
        quiescing.request(true).unwrap();
        quiescing
            .on_state(PID, 1, ShutdownPhase::Quiescing)
            .unwrap();
        assert!(quiescing.emergency_exit().is_err());

        let mut draining = HostShutdown::new(PID);
        draining.request(true).unwrap();
        draining.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        assert!(draining.emergency_exit().is_err());

        let mut closing = HostShutdown::new(PID);
        closing.request(true).unwrap();
        closing.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        closing.on_state(PID, 1, ShutdownPhase::Closing).unwrap();
        assert!(closing.emergency_exit().is_err());

        let mut complete = HostShutdown::new(PID);
        complete.request(true).unwrap();
        reach_closing(&mut complete);
        complete.on_complete(PID, 1).unwrap();
        assert!(complete.emergency_exit().is_err());
    }

    #[test]
    fn terminal_or_closing_phase_ignores_late_soft_deadline() {
        let mut closing = HostShutdown::new(PID);
        closing.request(true).unwrap();
        closing.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        closing.on_state(PID, 1, ShutdownPhase::Closing).unwrap();
        closing.on_soft_deadline(PID, 1).unwrap();
        assert_eq!(closing.snapshot().phase, ShutdownPhase::Closing);

        let mut complete = HostShutdown::new(PID);
        complete.request(true).unwrap();
        reach_closing(&mut complete);
        complete.on_complete(PID, 1).unwrap();
        complete.on_soft_deadline(PID, 1).unwrap();
        assert_eq!(
            complete.snapshot().phase,
            ShutdownPhase::CompleteWaitingForChild
        );

        let mut failed = HostShutdown::new(PID);
        failed.request(true).unwrap();
        failed.on_failed(PID, 1, "STORAGE_UNAVAILABLE").unwrap();
        failed.on_soft_deadline(PID, 1).unwrap();
        assert_eq!(failed.snapshot().phase, ShutdownPhase::Failed);

        let mut emergency = HostShutdown::new(PID);
        emergency.request(true).unwrap();
        emergency.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        emergency.on_soft_deadline(PID, 1).unwrap();
        emergency.emergency_exit().unwrap();
        emergency.on_soft_deadline(PID, 1).unwrap();
        assert_eq!(emergency.snapshot().phase, ShutdownPhase::Emergency);
    }

    #[test]
    fn cancelled_requires_a_pending_cancel_and_cannot_reopen_complete() {
        let mut unsolicited = HostShutdown::new(PID);
        unsolicited.request(true).unwrap();
        assert!(unsolicited.on_cancelled(PID, 1).is_err());
        assert_eq!(unsolicited.snapshot().phase, ShutdownPhase::Requesting);

        let mut pending = HostShutdown::new(PID);
        pending.request(true).unwrap();
        pending.on_state(PID, 1, ShutdownPhase::Draining).unwrap();
        pending.cancel().unwrap();
        pending.on_cancelled(PID, 1).unwrap();
        assert_eq!(pending.snapshot().phase, ShutdownPhase::Idle);

        let mut complete = HostShutdown::new(PID);
        complete.request(true).unwrap();
        reach_closing(&mut complete);
        complete.on_complete(PID, 1).unwrap();
        complete.on_cancelled(PID, 1).unwrap();
        assert_eq!(
            complete.snapshot().phase,
            ShutdownPhase::CompleteWaitingForChild
        );
    }

    #[test]
    fn host_failure_is_absorbing_and_cannot_be_relabelled_clean() {
        let mut host = HostShutdown::new(PID);
        host.request(true).unwrap();
        host.fail_current("SIDECAR_EVENT_ERROR");
        host.on_complete(PID, 1).unwrap();

        assert_eq!(host.snapshot().phase, ShutdownPhase::Failed);
        assert_eq!(host.snapshot().code.as_deref(), Some("SIDECAR_EVENT_ERROR"));
        assert!(!host.allow_app_exit());
    }
}
