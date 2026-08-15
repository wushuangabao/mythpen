#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_instance;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod shutdown;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod sidecar_protocol;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_runtime {
    use super::desktop_instance;
    use super::shutdown::{
        map_tauri_lifecycle, HostShutdown, HostShutdownEffect, HostShutdownSnapshot,
        LifecycleInput, LifecycleMapping, ShutdownPhase,
    };
    use super::sidecar_protocol::{
        classify_stdout_line, ChildControlFrame, ChildShutdownState, HandshakeEffect, NonceSecret,
        SidecarSession, SidecarSessionHandshake, StdoutLine,
    };
    use std::io;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager, State};
    use tauri_plugin_shell::process::{CommandChild, CommandEvent};
    use tauri_plugin_shell::ShellExt;

    const SHUTDOWN_EVENT: &str = "mythpen://shutdown-state";

    fn stable_io_error(code: &'static str) -> io::Error {
        io::Error::other(code)
    }

    struct SidecarHostInner {
        child: Option<CommandChild>,
        child_pid: u32,
        handshake: SidecarSessionHandshake,
        nonce: NonceSecret,
        shutdown: HostShutdown,
        termination: Option<(Option<i32>, Option<i32>)>,
    }

    impl SidecarHostInner {
        fn write_frame(&mut self, frame: String) -> Result<(), String> {
            let child = self
                .child
                .as_mut()
                .ok_or_else(|| "SIDECAR_CONTROL_UNAVAILABLE".to_owned())?;
            child
                .write(frame.as_bytes())
                .map_err(|_| "SIDECAR_CONTROL_WRITE_FAILED".to_owned())
        }

        fn apply_effect(&mut self, effect: HostShutdownEffect) -> Result<bool, String> {
            match effect {
                HostShutdownEffect::None => Ok(false),
                HostShutdownEffect::SendRequest { attempt_seq } => {
                    self.write_frame(self.nonce.shutdown_request_frame(attempt_seq))?;
                    Ok(false)
                }
                HostShutdownEffect::SendCancel { attempt_seq } => {
                    self.write_frame(self.nonce.shutdown_cancel_frame(attempt_seq))?;
                    Ok(false)
                }
                HostShutdownEffect::SendContinueWait { attempt_seq } => {
                    self.write_frame(self.nonce.shutdown_continue_wait_frame(attempt_seq))?;
                    Ok(false)
                }
                HostShutdownEffect::KillOwnedChild => {
                    if let Some(child) = self.child.take() {
                        child
                            .kill()
                            .map_err(|_| "SIDECAR_OWNED_KILL_FAILED".to_owned())?;
                        return Ok(false);
                    }
                    if let Some((code, signal)) = self.termination {
                        return self
                            .shutdown
                            .on_terminated(self.child_pid, code, signal)
                            .map(|effect| effect == HostShutdownEffect::ExitApp)
                            .map_err(|error| error.code().to_owned());
                    }
                    Err("SIDECAR_OWNED_HANDLE_UNAVAILABLE".to_owned())
                }
                HostShutdownEffect::ExitApp => Ok(true),
            }
        }

        fn session(&self) -> Option<SidecarSession> {
            self.handshake.session().cloned()
        }
    }

    struct SidecarHost {
        inner: Mutex<SidecarHostInner>,
    }

    impl SidecarHost {
        fn new(child: CommandChild, child_pid: u32, nonce: NonceSecret) -> Self {
            let handshake = SidecarSessionHandshake::new(
                child_pid,
                nonce.expose_for_renderer(),
                nonce.digest_hex(),
            );
            Self {
                inner: Mutex::new(SidecarHostInner {
                    child: Some(child),
                    child_pid,
                    handshake,
                    nonce,
                    shutdown: HostShutdown::new(child_pid),
                    termination: None,
                }),
            }
        }
    }

    fn emit_shutdown_snapshot(app: &AppHandle, snapshot: &HostShutdownSnapshot) {
        let _ = app.emit(SHUTDOWN_EVENT, snapshot);
    }

    fn with_host_action<F>(
        app: &AppHandle,
        host: &SidecarHost,
        action: F,
    ) -> Result<HostShutdownSnapshot, String>
    where
        F: FnOnce(&mut SidecarHostInner) -> Result<HostShutdownEffect, String>,
    {
        let (snapshot, should_exit) = {
            let mut inner = host
                .inner
                .lock()
                .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
            let effect = action(&mut inner)?;
            let should_exit = inner.apply_effect(effect)?;
            (inner.shutdown.snapshot(), should_exit)
        };
        emit_shutdown_snapshot(app, &snapshot);
        if should_exit {
            app.exit(0);
        }
        Ok(snapshot)
    }

    fn fail_host(app: &AppHandle, code: &'static str) {
        let Some(host) = app.try_state::<SidecarHost>() else {
            return;
        };
        let snapshot = {
            let Ok(mut inner) = host.inner.lock() else {
                return;
            };
            inner.shutdown.fail_current(code);
            inner.shutdown.snapshot()
        };
        emit_shutdown_snapshot(app, &snapshot);
    }

    fn handle_control_frame(app: &AppHandle, frame: ChildControlFrame) -> Result<(), String> {
        let host = app
            .try_state::<SidecarHost>()
            .ok_or_else(|| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
        let (snapshot, emit_snapshot) = {
            let mut inner = host
                .inner
                .lock()
                .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
            let mut emit_snapshot = false;
            match frame {
                frame @ (ChildControlFrame::Ready { .. } | ChildControlFrame::BuildInfo { .. }) => {
                    match inner
                        .handshake
                        .accept(frame)
                        .map_err(|error| error.code().to_owned())?
                    {
                        HandshakeEffect::RequestBuildInfo => {
                            let frame = inner.nonce.build_info_request_frame();
                            inner.write_frame(frame)?;
                        }
                        HandshakeEffect::Published => {}
                    }
                }
                ChildControlFrame::ShutdownState {
                    child_pid,
                    attempt_seq,
                    state,
                } => {
                    let phase = match state {
                        ChildShutdownState::Quiescing => ShutdownPhase::Quiescing,
                        ChildShutdownState::Draining => ShutdownPhase::Draining,
                        ChildShutdownState::Closing => ShutdownPhase::Closing,
                    };
                    inner
                        .shutdown
                        .on_state(child_pid, attempt_seq, phase)
                        .map_err(|error| error.code().to_owned())?;
                    emit_snapshot = true;
                }
                ChildControlFrame::ShutdownSoftDeadline {
                    child_pid,
                    attempt_seq,
                    state: _,
                } => {
                    inner
                        .shutdown
                        .on_soft_deadline(child_pid, attempt_seq)
                        .map_err(|error| error.code().to_owned())?;
                    emit_snapshot = true;
                }
                ChildControlFrame::ShutdownCancelled {
                    child_pid,
                    attempt_seq,
                    service_epoch: _,
                } => {
                    inner
                        .shutdown
                        .on_cancelled(child_pid, attempt_seq)
                        .map_err(|error| error.code().to_owned())?;
                    emit_snapshot = true;
                }
                ChildControlFrame::ShutdownComplete {
                    child_pid,
                    attempt_seq,
                } => {
                    inner
                        .shutdown
                        .on_complete(child_pid, attempt_seq)
                        .map_err(|error| error.code().to_owned())?;
                    emit_snapshot = true;
                }
                ChildControlFrame::ShutdownFailed {
                    child_pid,
                    attempt_seq,
                    code,
                } => {
                    inner
                        .shutdown
                        .on_failed(child_pid, attempt_seq, &code)
                        .map_err(|error| error.code().to_owned())?;
                    emit_snapshot = true;
                }
                ChildControlFrame::ControlError { code: _ } => {
                    inner.shutdown.fail_current("SIDECAR_CONTROL_REJECTED");
                    emit_snapshot = true;
                }
            }
            (inner.shutdown.snapshot(), emit_snapshot)
        };
        if emit_snapshot {
            emit_shutdown_snapshot(app, &snapshot);
        }
        Ok(())
    }

    fn handle_command_event(app: &AppHandle, event: CommandEvent) -> bool {
        match event {
            CommandEvent::Stdout(line) => match classify_stdout_line(&line) {
                Ok(StdoutLine::Log) => {}
                Ok(StdoutLine::Control(frame)) => {
                    if handle_control_frame(app, frame).is_err() {
                        fail_host(app, "SIDECAR_PROTOCOL_FAILURE");
                    }
                }
                Err(_) => fail_host(app, "SIDECAR_PROTOCOL_FAILURE"),
            },
            CommandEvent::Stderr(_) => {
                // Consume stderr without forwarding raw child output or secrets.
            }
            CommandEvent::Error(_) => fail_host(app, "SIDECAR_EVENT_ERROR"),
            CommandEvent::Terminated(payload) => {
                let Some(host) = app.try_state::<SidecarHost>() else {
                    return true;
                };
                let (snapshot, should_exit) = {
                    let Ok(mut inner) = host.inner.lock() else {
                        return true;
                    };
                    inner.handshake.invalidate();
                    inner.child.take();
                    inner.termination = Some((payload.code, payload.signal));
                    let child_pid = inner.child_pid;
                    let effect = inner
                        .shutdown
                        .on_terminated(child_pid, payload.code, payload.signal)
                        .unwrap_or(HostShutdownEffect::None);
                    (
                        inner.shutdown.snapshot(),
                        effect == HostShutdownEffect::ExitApp,
                    )
                };
                emit_shutdown_snapshot(app, &snapshot);
                if should_exit {
                    app.exit(0);
                }
                return true;
            }
            _ => {}
        }
        false
    }

    fn spawn_owned_sidecar(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
        let nonce = NonceSecret::generate().map_err(|_| stable_io_error("SIDECAR_NONCE_FAILED"))?;
        let bootstrap = nonce.bootstrap_frame();
        let command = app
            .shell()
            .sidecar("mythpen-server")
            .map_err(|_| stable_io_error("SIDECAR_COMMAND_FAILED"))?
            .envs(desktop_instance::owned_sidecar_environment());
        let (mut receiver, mut child) = command
            .spawn()
            .map_err(|_| stable_io_error("SIDECAR_SPAWN_FAILED"))?;
        let child_pid = child.pid();
        if child.write(bootstrap.as_bytes()).is_err() {
            let _ = child.kill();
            return Err(stable_io_error("SIDECAR_BOOTSTRAP_FAILED").into());
        }

        app.manage(SidecarHost::new(child, child_pid, nonce));
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let mut terminated = false;
            while let Some(event) = receiver.recv().await {
                if handle_command_event(&app_handle, event) {
                    terminated = true;
                }
            }
            if !terminated {
                fail_host(&app_handle, "SIDECAR_EVENT_STREAM_ENDED");
            }
        });
        Ok(())
    }

    #[tauri::command]
    fn get_sidecar_session(
        state: State<'_, SidecarHost>,
    ) -> Result<Option<SidecarSession>, String> {
        state
            .inner
            .lock()
            .map(|inner| inner.session())
            .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())
    }

    #[tauri::command]
    fn request_shutdown(
        app: AppHandle,
        state: State<'_, SidecarHost>,
    ) -> Result<HostShutdownSnapshot, String> {
        with_host_action(&app, &state, |inner| {
            let ready = inner.session().is_some();
            inner
                .shutdown
                .request(ready)
                .map_err(|error| error.code().to_owned())
        })
    }

    #[tauri::command]
    fn cancel_shutdown(
        app: AppHandle,
        state: State<'_, SidecarHost>,
    ) -> Result<HostShutdownSnapshot, String> {
        with_host_action(&app, &state, |inner| {
            inner
                .shutdown
                .cancel()
                .map_err(|error| error.code().to_owned())
        })
    }

    #[tauri::command]
    fn continue_shutdown_wait(
        app: AppHandle,
        state: State<'_, SidecarHost>,
    ) -> Result<HostShutdownSnapshot, String> {
        with_host_action(&app, &state, |inner| {
            inner
                .shutdown
                .continue_wait()
                .map_err(|error| error.code().to_owned())
        })
    }

    #[tauri::command]
    fn emergency_exit(
        app: AppHandle,
        state: State<'_, SidecarHost>,
    ) -> Result<HostShutdownSnapshot, String> {
        with_host_action(&app, &state, |inner| {
            inner
                .shutdown
                .emergency_exit()
                .map_err(|error| error.code().to_owned())
        })
    }

    fn allow_app_exit(app: &AppHandle) -> bool {
        app.try_state::<SidecarHost>()
            .and_then(|host| {
                host.inner
                    .lock()
                    .ok()
                    .map(|inner| inner.shutdown.allow_app_exit())
            })
            .unwrap_or(false)
    }

    fn begin_or_replay_shutdown(app: &AppHandle) {
        let Some(host) = app.try_state::<SidecarHost>() else {
            return;
        };
        if with_host_action(app, &host, |inner| {
            let ready = inner.session().is_some();
            inner
                .shutdown
                .request(ready)
                .map_err(|error| error.code().to_owned())
        })
        .is_err()
        {
            fail_host(app, "SHUTDOWN_REQUEST_FAILED");
        }
    }

    pub(super) fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
                desktop_instance::focus_main_window(app);
            }))
            .plugin(tauri_plugin_shell::init())
            .invoke_handler(tauri::generate_handler![
                get_sidecar_session,
                request_shutdown,
                cancel_shutdown,
                continue_shutdown_wait,
                emergency_exit,
            ])
            .setup(|app| {
                spawn_owned_sidecar(app)?;
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app_handle, event| match event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } if label == "main" => {
                    match map_tauri_lifecycle(
                        LifecycleInput::MainWindowCloseRequested,
                        allow_app_exit(app_handle),
                    ) {
                        LifecycleMapping::PreventCloseAndBeginOrReplay => {
                            api.prevent_close();
                            begin_or_replay_shutdown(app_handle);
                        }
                        LifecycleMapping::AllowExit
                        | LifecycleMapping::PreventExitAndBeginOrReplay
                        | LifecycleMapping::CleanupOnly => {}
                    }
                }
                tauri::RunEvent::ExitRequested { api, .. } => {
                    match map_tauri_lifecycle(
                        LifecycleInput::ExitRequested,
                        allow_app_exit(app_handle),
                    ) {
                        LifecycleMapping::PreventExitAndBeginOrReplay => {
                            api.prevent_exit();
                            begin_or_replay_shutdown(app_handle);
                        }
                        LifecycleMapping::AllowExit
                        | LifecycleMapping::PreventCloseAndBeginOrReplay
                        | LifecycleMapping::CleanupOnly => {}
                    }
                }
                tauri::RunEvent::Exit => {
                    let _ = map_tauri_lifecycle(LifecycleInput::Exit, allow_app_exit(app_handle));
                }
                _ => {}
            });
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn run() {
    desktop_runtime::run();
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
