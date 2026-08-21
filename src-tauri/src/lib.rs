#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_instance;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod manuscript_files;
#[cfg(all(not(any(target_os = "android", target_os = "ios")), debug_assertions))]
mod migration_preflight_smoke;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod shutdown;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod sidecar_protocol;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop_runtime {
    use super::desktop_instance;
    #[cfg(debug_assertions)]
    use super::manuscript_files::debug_files_smoke::{
        claim_authenticated_request, load_authenticated_request, load_migration_preflight_request,
        sidecar_json_request, DebugFilesSmokeRequest, DebugSidecarJsonRequest,
        DEBUG_FILES_SMOKE_CASE_IDS, DEBUG_FILES_SMOKE_MARKER,
    };
    use super::manuscript_files::{
        open_allowed_external_https, resolve_authenticated_open_manuscript_resource,
        resolve_authenticated_reveal_manuscript_project, resolve_desktop_data_root,
        ManuscriptFileLauncher, ManuscriptResourceKind, ManuscriptResourceRequest,
        SystemManuscriptLauncher,
    };
    #[cfg(debug_assertions)]
    use super::migration_preflight_smoke::{
        BootstrapBinding as MigrationPreflightBootstrapBinding,
        MigrationRequest as MigrationPreflightRequest, SmokeCase as MigrationPreflightSmokeCase,
        State as MigrationPreflightSmokeState, MARKER as MIGRATION_PREFLIGHT_SMOKE_MARKER,
    };
    use super::shutdown::{
        map_tauri_lifecycle, HostShutdown, HostShutdownEffect, HostShutdownSnapshot,
        LifecycleInput, LifecycleMapping, ShutdownPhase,
    };
    use super::sidecar_protocol::{
        classify_stdout_line, ChildControlFrame, ChildShutdownState, HandshakeEffect, NonceSecret,
        SidecarSession, SidecarSessionHandshake, StdoutLine,
    };
    use std::io;
    use std::path::PathBuf;
    use std::sync::Mutex;
    #[cfg(debug_assertions)]
    use std::time::Duration;
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
        data_root: PathBuf,
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
        fn new(
            child: CommandChild,
            child_pid: u32,
            nonce: NonceSecret,
            data_root: PathBuf,
        ) -> Self {
            let handshake = SidecarSessionHandshake::new(
                child_pid,
                nonce.expose_for_renderer(),
                nonce.digest_hex(),
            );
            Self {
                inner: Mutex::new(SidecarHostInner {
                    child: Some(child),
                    child_pid,
                    data_root,
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
        let data_root = resolve_desktop_data_root()
            .map_err(|_| stable_io_error("MANUSCRIPT_DATA_ROOT_INVALID"))?;
        let nonce = NonceSecret::generate().map_err(|_| stable_io_error("SIDECAR_NONCE_FAILED"))?;
        let bootstrap = nonce.bootstrap_frame();
        let command = app
            .shell()
            .sidecar("mythpen-server")
            .map_err(|_| stable_io_error("SIDECAR_COMMAND_FAILED"))?
            .envs(desktop_instance::owned_sidecar_environment())
            .env("MYTHPEN_DATA_DIR", &data_root);
        let (mut receiver, mut child) = command
            .spawn()
            .map_err(|_| stable_io_error("SIDECAR_SPAWN_FAILED"))?;
        let child_pid = child.pid();
        if child.write(bootstrap.as_bytes()).is_err() {
            let _ = child.kill();
            return Err(stable_io_error("SIDECAR_BOOTSTRAP_FAILED").into());
        }

        app.manage(SidecarHost::new(child, child_pid, nonce, data_root));
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

    fn manuscript_host_session_transport(
        state: &SidecarHost,
    ) -> Result<(SidecarSession, PathBuf), String> {
        state
            .inner
            .lock()
            .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())
            .and_then(|inner| {
                inner
                    .session()
                    .map(|session| (session, inner.data_root.clone()))
                    .ok_or_else(|| "MANUSCRIPT_HOST_UNAUTHENTICATED".to_owned())
            })
    }

    fn launch_with_current_sidecar_session<F>(
        state: &SidecarHost,
        expected_session: &SidecarSession,
        expected_data_root: &PathBuf,
        launch: F,
    ) -> Result<(), String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let inner = state
            .inner
            .lock()
            .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
        if inner.session().as_ref() != Some(expected_session)
            || &inner.data_root != expected_data_root
        {
            return Err("MANUSCRIPT_HOST_UNAUTHENTICATED".to_owned());
        }
        launch()
    }

    fn execute_open_manuscript_resource(
        state: &SidecarHost,
        request: &ManuscriptResourceRequest,
        launcher: &dyn ManuscriptFileLauncher,
    ) -> Result<(), String> {
        let (session, data_root) = manuscript_host_session_transport(state)?;
        let target = resolve_authenticated_open_manuscript_resource(
            &data_root,
            session.port,
            &session.nonce,
            request,
        )
        .map_err(|error| error.code().to_owned())?;
        launch_with_current_sidecar_session(state, &session, &data_root, || {
            launcher.open(target.path())
        })
    }

    fn execute_reveal_manuscript_project(
        state: &SidecarHost,
        project_uid: &str,
        project_instance_uid: &str,
        launcher: &dyn ManuscriptFileLauncher,
    ) -> Result<(), String> {
        let (session, data_root) = manuscript_host_session_transport(state)?;
        let target = resolve_authenticated_reveal_manuscript_project(
            &data_root,
            session.port,
            &session.nonce,
            project_uid,
            project_instance_uid,
        )
        .map_err(|error| error.code().to_owned())?;
        launch_with_current_sidecar_session(state, &session, &data_root, || {
            launcher.reveal(target.path())
        })
    }

    #[tauri::command]
    fn open_manuscript_resource(
        state: State<'_, SidecarHost>,
        project_uid: String,
        project_instance_uid: String,
        resource_kind: String,
        resource_uid: String,
    ) -> Result<(), String> {
        let kind = ManuscriptResourceKind::from_wire(&resource_kind)
            .map_err(|error| error.code().to_owned())?;
        let request = ManuscriptResourceRequest::new(
            &project_uid,
            &project_instance_uid,
            kind,
            &resource_uid,
        )
        .map_err(|error| error.code().to_owned())?;
        execute_open_manuscript_resource(&state, &request, &SystemManuscriptLauncher)
    }

    #[tauri::command]
    fn reveal_manuscript_project(
        state: State<'_, SidecarHost>,
        project_uid: String,
        project_instance_uid: String,
    ) -> Result<(), String> {
        execute_reveal_manuscript_project(
            &state,
            &project_uid,
            &project_instance_uid,
            &SystemManuscriptLauncher,
        )
    }

    #[tauri::command]
    fn open_external_https(url: String) -> Result<(), String> {
        open_allowed_external_https(&url, &SystemManuscriptLauncher)
            .map_err(|error| error.code().to_owned())
    }

    #[cfg(debug_assertions)]
    #[derive(Default)]
    struct DebugRecordingLauncher {
        targets: Mutex<Vec<PathBuf>>,
    }

    #[cfg(debug_assertions)]
    impl ManuscriptFileLauncher for DebugRecordingLauncher {
        fn open(&self, path: &std::path::Path) -> Result<(), String> {
            self.targets
                .lock()
                .map_err(|_| "MANUSCRIPT_SMOKE_LAUNCHER_FAILED".to_owned())?
                .push(path.to_path_buf());
            Ok(())
        }

        fn reveal(&self, path: &std::path::Path) -> Result<(), String> {
            self.open(path)
        }
    }

    #[cfg(debug_assertions)]
    impl DebugRecordingLauncher {
        fn targets(&self) -> Result<Vec<PathBuf>, String> {
            self.targets
                .lock()
                .map(|targets| targets.clone())
                .map_err(|_| "MANUSCRIPT_SMOKE_LAUNCHER_FAILED".to_owned())
        }
    }

    #[cfg(debug_assertions)]
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DebugSmokeArtifactIdentity {
        path: String,
        bytes: u64,
        sha256: String,
    }

    #[cfg(debug_assertions)]
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DebugSmokeAuth {
        mode: &'static str,
    }

    #[cfg(debug_assertions)]
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DebugSmokeSuite {
        total: usize,
        passed: usize,
        failed: usize,
    }

    #[cfg(debug_assertions)]
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DebugSmokeCase {
        id: &'static str,
        status: &'static str,
        launch_calls: usize,
        target: Option<String>,
        error_code: Option<String>,
    }

    #[cfg(debug_assertions)]
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DebugSmokeResult {
        version: u8,
        #[serde(rename = "type")]
        result_type: &'static str,
        status: &'static str,
        source_commit: String,
        target_triple: String,
        desktop: DebugSmokeArtifactIdentity,
        sidecar: DebugSmokeArtifactIdentity,
        auth: DebugSmokeAuth,
        run_id: String,
        request: DebugSmokeArtifactIdentity,
        suite: DebugSmokeSuite,
        cases: Vec<DebugSmokeCase>,
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_sha256_file(path: &std::path::Path) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        use std::io::Read;

        let mut file = std::fs::File::open(path)
            .map_err(|_| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())?;
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|_| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())?;
            if count == 0 {
                break;
            }
            hasher.update(&buffer[..count]);
        }
        Ok(hex::encode(hasher.finalize()))
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_artifact_identity(
        path: &std::path::Path,
    ) -> Result<DebugSmokeArtifactIdentity, String> {
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|_| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned());
        }
        Ok(DebugSmokeArtifactIdentity {
            path: path
                .to_str()
                .ok_or_else(|| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())?
                .to_owned(),
            bytes: metadata.len(),
            sha256: debug_smoke_sha256_file(path)?,
        })
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_request_identity(
        request: &DebugFilesSmokeRequest,
    ) -> Result<DebugSmokeArtifactIdentity, String> {
        use sha2::{Digest, Sha256};

        Ok(DebugSmokeArtifactIdentity {
            path: request
                .request_path()
                .to_str()
                .ok_or_else(|| "MANUSCRIPT_SMOKE_REQUEST_INVALID".to_owned())?
                .to_owned(),
            bytes: request.request_bytes().len() as u64,
            sha256: hex::encode(Sha256::digest(request.request_bytes())),
        })
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_path_string(path: &std::path::Path) -> Result<String, String> {
        path.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_positive_case<F>(
        id: &'static str,
        expected_target: &std::path::Path,
        execute: F,
    ) -> DebugSmokeCase
    where
        F: FnOnce(&DebugRecordingLauncher) -> Result<(), String>,
    {
        let launcher = DebugRecordingLauncher::default();
        let result = execute(&launcher);
        let targets = launcher.targets().unwrap_or_default();
        let passed = result.is_ok()
            && targets.len() == 1
            && targets.first().is_some_and(|path| path == expected_target);
        DebugSmokeCase {
            id,
            status: if passed { "PASS" } else { "FAIL" },
            launch_calls: targets.len(),
            target: targets
                .first()
                .and_then(|path| debug_smoke_path_string(path).ok()),
            error_code: result.err(),
        }
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_negative_case<F>(id: &'static str, execute: F) -> DebugSmokeCase
    where
        F: FnOnce(&DebugRecordingLauncher) -> Result<(), String>,
    {
        let launcher = DebugRecordingLauncher::default();
        let result = execute(&launcher);
        let targets = launcher.targets().unwrap_or_default();
        let passed = result.is_err() && targets.is_empty();
        DebugSmokeCase {
            id,
            status: if passed { "PASS" } else { "FAIL" },
            launch_calls: targets.len(),
            target: targets
                .first()
                .and_then(|path| debug_smoke_path_string(path).ok()),
            error_code: result.err(),
        }
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_failed_cases(code: String) -> Vec<DebugSmokeCase> {
        DEBUG_FILES_SMOKE_CASE_IDS
            .into_iter()
            .map(|id| DebugSmokeCase {
                id,
                status: "FAIL",
                launch_calls: 0,
                target: None,
                error_code: Some(code.clone()),
            })
            .collect()
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_value_string(value: &serde_json::Value, key: &str) -> Result<String, String> {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| "MANUSCRIPT_SMOKE_RESPONSE_INVALID".to_owned())
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_witness(
        session: &SidecarSession,
        project_name: &str,
        project_instance_uid: &str,
    ) -> Result<serde_json::Value, String> {
        let response = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "GET",
                target: &format!("/api/{project_name}/manuscript/witness"),
                request_id: None,
                project_instance_uid: Some(project_instance_uid),
                body: None,
                expected_status: 200,
            },
        )?;
        response
            .get("base_witness")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| "MANUSCRIPT_SMOKE_RESPONSE_INVALID".to_owned())
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_create_fixture(
        session: &SidecarSession,
        request: &DebugFilesSmokeRequest,
    ) -> Result<(String, String, String, String), String> {
        let project_name = format!("desktop-files-smoke-{}", request.run_id());
        let create_request_id = format!("desktop-files-smoke-create-{}", request.run_id());
        let created = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: "/api/projects/files-beta",
                request_id: Some(&create_request_id),
                project_instance_uid: None,
                body: Some(&serde_json::json!({
                "name": project_name,
                "mode": "medium-novel",
                "language": "zh",
                "genres": ["fantasy"],
                })),
                expected_status: 201,
            },
        )?;
        let project_uid = debug_smoke_value_string(&created, "projectUid")?;
        let status = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "GET",
                target: &format!("/api/projects/by-name/{project_name}/files-beta/status"),
                request_id: None,
                project_instance_uid: None,
                body: None,
                expected_status: 200,
            },
        )?;
        if status.get("route").and_then(serde_json::Value::as_str) != Some("files")
            || status
                .get("project_uid")
                .and_then(serde_json::Value::as_str)
                != Some(project_uid.as_str())
        {
            return Err("MANUSCRIPT_SMOKE_RESPONSE_INVALID".to_owned());
        }
        let project_instance_uid = debug_smoke_value_string(&status, "project_instance_id")?;
        let witness = debug_smoke_witness(session, &project_name, &project_instance_uid)?;
        let volume_request_id = format!("desktop-files-smoke-volume-{}", request.run_id());
        let volume = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: &format!("/api/{project_name}/volumes"),
                request_id: Some(&volume_request_id),
                project_instance_uid: Some(&project_instance_uid),
                body: Some(&serde_json::json!({
                    "base_witness": witness,
                    "title": "Smoke volume",
                    "summary": "",
                })),
                expected_status: 201,
            },
        )?;
        let volume_uid = debug_smoke_value_string(&volume, "uid")?;
        let witness = debug_smoke_witness(session, &project_name, &project_instance_uid)?;
        let chapter_request_id = format!("desktop-files-smoke-chapter-{}", request.run_id());
        let chapter = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: &format!("/api/{project_name}/chapters"),
                request_id: Some(&chapter_request_id),
                project_instance_uid: Some(&project_instance_uid),
                body: Some(&serde_json::json!({
                    "base_witness": witness,
                    "container_volume_uid": volume_uid,
                    "requested_num": null,
                    "title": "Smoke chapter",
                    "outline": "",
                    "summary": "",
                    "status": "pending",
                    "content": "",
                    "cognitive_frame": "",
                    "emotional_anchor": "",
                    "world_texture": "",
                    "concrete_mystery": "",
                    "interpersonal_tension": "",
                })),
                expected_status: 201,
            },
        )?;
        let chapter_uid = debug_smoke_value_string(&chapter, "uid")?;
        Ok((
            project_name,
            project_uid,
            project_instance_uid,
            format!("{volume_uid}\n{chapter_uid}"),
        ))
    }

    #[cfg(debug_assertions)]
    fn debug_smoke_run_matrix(
        state: &SidecarHost,
        session: &SidecarSession,
        data_root: &std::path::Path,
        request: &DebugFilesSmokeRequest,
    ) -> Result<Vec<DebugSmokeCase>, String> {
        let (project_name, project_uid, project_instance_uid, resource_uids) =
            debug_smoke_create_fixture(session, request)?;
        let (volume_uid, chapter_uid) = resource_uids
            .split_once('\n')
            .ok_or_else(|| "MANUSCRIPT_SMOKE_RESPONSE_INVALID".to_owned())?;
        let article_root = data_root.join("manuscripts").join(&project_uid);
        let mythpen_root = article_root.join("mythpen");
        let chapters_root = mythpen_root.join("chapters");
        let body_path = chapters_root.join(format!("ch_{chapter_uid}.md"));
        let sidecar_path = chapters_root.join(format!("ch_{chapter_uid}.json"));
        let volume_path = mythpen_root
            .join("volumes")
            .join(format!("vol_{volume_uid}.json"));

        let chapter_body_request = ManuscriptResourceRequest::new(
            &project_uid,
            &project_instance_uid,
            ManuscriptResourceKind::ChapterBody,
            chapter_uid,
        )
        .map_err(|error| error.code().to_owned())?;
        let chapter_sidecar_request = ManuscriptResourceRequest::new(
            &project_uid,
            &project_instance_uid,
            ManuscriptResourceKind::ChapterSidecar,
            chapter_uid,
        )
        .map_err(|error| error.code().to_owned())?;
        let volume_request = ManuscriptResourceRequest::new(
            &project_uid,
            &project_instance_uid,
            ManuscriptResourceKind::VolumeIndex,
            volume_uid,
        )
        .map_err(|error| error.code().to_owned())?;

        let mut cases = vec![
            debug_smoke_positive_case("open_chapter_body", &body_path, |launcher| {
                execute_open_manuscript_resource(state, &chapter_body_request, launcher)
            }),
            debug_smoke_positive_case("open_chapter_sidecar", &sidecar_path, |launcher| {
                execute_open_manuscript_resource(state, &chapter_sidecar_request, launcher)
            }),
            debug_smoke_positive_case("open_volume_index", &volume_path, |launcher| {
                execute_open_manuscript_resource(state, &volume_request, launcher)
            }),
            debug_smoke_positive_case("reveal_project", &article_root, |launcher| {
                execute_reveal_manuscript_project(
                    state,
                    &project_uid,
                    &project_instance_uid,
                    launcher,
                )
            }),
        ];

        let unknown_request = ManuscriptResourceRequest::new(
            &project_uid,
            &project_instance_uid,
            ManuscriptResourceKind::ChapterBody,
            "77777777-7777-4777-8777-777777777777",
        )
        .map_err(|error| error.code().to_owned())?;
        cases.push(debug_smoke_negative_case(
            "unknown_uid_rejected",
            |launcher| execute_open_manuscript_resource(state, &unknown_request, launcher),
        ));

        let sqlite_name = format!("desktop-sqlite-smoke-{}", request.run_id());
        let sqlite = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: "/api/projects",
                request_id: None,
                project_instance_uid: None,
                body: Some(&serde_json::json!({
                    "name": sqlite_name,
                    "mode": "medium-novel",
                    "language": "zh",
                    "genres": ["other"],
                })),
                expected_status: 200,
            },
        )?;
        let sqlite_instance_uid = debug_smoke_value_string(&sqlite, "instanceId")?;
        let wrong_route_request = ManuscriptResourceRequest::new(
            "88888888-8888-4888-8888-888888888888",
            &sqlite_instance_uid,
            ManuscriptResourceKind::ChapterBody,
            chapter_uid,
        )
        .map_err(|error| error.code().to_owned())?;
        cases.push(debug_smoke_negative_case(
            "wrong_route_rejected",
            |launcher| execute_open_manuscript_resource(state, &wrong_route_request, launcher),
        ));

        let hard_link_path = chapters_root.join(format!(".hard-link-{chapter_uid}.md"));
        std::fs::hard_link(&body_path, &hard_link_path)
            .map_err(|_| "MANUSCRIPT_SMOKE_HARD_LINK_SETUP_FAILED".to_owned())?;
        let hard_link_case = debug_smoke_negative_case("hard_link_rejected", |launcher| {
            execute_open_manuscript_resource(state, &chapter_body_request, launcher)
        });
        std::fs::remove_file(&hard_link_path)
            .map_err(|_| "MANUSCRIPT_SMOKE_HARD_LINK_CLEANUP_FAILED".to_owned())?;
        cases.push(hard_link_case);

        let chapters_real = mythpen_root.join(".chapters-smoke-real");
        std::fs::rename(&chapters_root, &chapters_real)
            .map_err(|_| "MANUSCRIPT_SMOKE_REPARSE_SETUP_FAILED".to_owned())?;
        #[cfg(windows)]
        let junction_status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&chapters_root)
            .arg(&chapters_real)
            .status()
            .map_err(|_| "MANUSCRIPT_SMOKE_REPARSE_SETUP_FAILED".to_owned())?;
        #[cfg(not(windows))]
        let junction_status = {
            std::os::unix::fs::symlink(&chapters_real, &chapters_root)
                .map_err(|_| "MANUSCRIPT_SMOKE_REPARSE_SETUP_FAILED".to_owned())?;
            std::process::Command::new("true")
                .status()
                .map_err(|_| "MANUSCRIPT_SMOKE_REPARSE_SETUP_FAILED".to_owned())?
        };
        if !junction_status.success() {
            let _ = std::fs::rename(&chapters_real, &chapters_root);
            return Err("MANUSCRIPT_SMOKE_REPARSE_SETUP_FAILED".to_owned());
        }
        let reparse_case = debug_smoke_negative_case("reparse_alias_rejected", |launcher| {
            execute_open_manuscript_resource(state, &chapter_body_request, launcher)
        });
        std::fs::remove_dir(&chapters_root)
            .map_err(|_| "MANUSCRIPT_SMOKE_REPARSE_CLEANUP_FAILED".to_owned())?;
        std::fs::rename(&chapters_real, &chapters_root)
            .map_err(|_| "MANUSCRIPT_SMOKE_REPARSE_CLEANUP_FAILED".to_owned())?;
        cases.push(reparse_case);

        if cases
            .iter()
            .map(|case| case.id)
            .ne(DEBUG_FILES_SMOKE_CASE_IDS)
        {
            return Err("MANUSCRIPT_SMOKE_MATRIX_INVALID".to_owned());
        }
        let _ = project_name;
        Ok(cases)
    }

    #[cfg(debug_assertions)]
    fn write_debug_smoke_result(
        request: &DebugFilesSmokeRequest,
        session: &SidecarSession,
        cases: Vec<DebugSmokeCase>,
    ) -> Result<(), String> {
        use std::io::Write;

        let desktop_path =
            std::env::current_exe().map_err(|_| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())?;
        let actual_sidecar_path = desktop_path
            .parent()
            .ok_or_else(|| "MANUSCRIPT_SMOKE_ARTIFACT_INVALID".to_owned())?
            .join(if cfg!(windows) {
                "mythpen-server.exe"
            } else {
                "mythpen-server"
            });
        let actual_sidecar = debug_smoke_artifact_identity(&actual_sidecar_path)?;
        let requested_sidecar = debug_smoke_artifact_identity(request.sidecar_path())?;
        if actual_sidecar.bytes != requested_sidecar.bytes
            || actual_sidecar.sha256 != requested_sidecar.sha256
        {
            return Err("MANUSCRIPT_SMOKE_SIDECAR_IDENTITY_MISMATCH".to_owned());
        }
        let passed = cases.iter().filter(|case| case.status == "PASS").count();
        let failed = DEBUG_FILES_SMOKE_CASE_IDS.len().saturating_sub(passed);
        let result = DebugSmokeResult {
            version: 1,
            result_type: "mythpen.desktop-l2-files-smoke.v1",
            status: if failed == 0 { "PASS" } else { "FAIL" },
            source_commit: session.build_info.source_commit.clone(),
            target_triple: session.build_info.target_triple.clone(),
            desktop: debug_smoke_artifact_identity(&desktop_path)?,
            sidecar: requested_sidecar,
            auth: DebugSmokeAuth {
                mode: "debug-only-one-time-nonce-v1",
            },
            run_id: request.run_id().to_owned(),
            request: debug_smoke_request_identity(request)?,
            suite: DebugSmokeSuite {
                total: DEBUG_FILES_SMOKE_CASE_IDS.len(),
                passed,
                failed,
            },
            cases,
        };
        let mut bytes = serde_json::to_vec(&result)
            .map_err(|_| "MANUSCRIPT_SMOKE_RESULT_INVALID".to_owned())?;
        bytes.push(b'\n');
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(request.result_path())
            .map_err(|_| "MANUSCRIPT_SMOKE_RESULT_CREATE_FAILED".to_owned())?;
        file.write_all(&bytes)
            .map_err(|_| "MANUSCRIPT_SMOKE_RESULT_WRITE_FAILED".to_owned())?;
        file.sync_all()
            .map_err(|_| "MANUSCRIPT_SMOKE_RESULT_WRITE_FAILED".to_owned())
    }

    #[cfg(debug_assertions)]
    fn prepare_debug_files_smoke() -> Result<Option<DebugFilesSmokeRequest>, String> {
        let Some(nonce) = std::env::var_os("MYTHPEN_DESKTOP_FILES_SMOKE_NONCE") else {
            return Ok(None);
        };
        let nonce = nonce
            .into_string()
            .map_err(|_| "MANUSCRIPT_SMOKE_UNAUTHENTICATED".to_owned())?;
        let arguments = std::env::args_os().collect::<Vec<_>>();
        if arguments.len() != 2 {
            return Err("MANUSCRIPT_SMOKE_REQUEST_INVALID".to_owned());
        }
        let request_path = PathBuf::from(&arguments[1]);
        let request = load_authenticated_request(&request_path, &nonce)
            .map_err(|error| error.code().to_owned())?;
        claim_authenticated_request(&request).map_err(|error| error.code().to_owned())?;
        std::env::remove_var("MYTHPEN_DESKTOP_FILES_SMOKE_NONCE");
        if DEBUG_FILES_SMOKE_MARKER != "mythpen.desktop-l2-files-smoke-bootstrap.v1" {
            return Err("MANUSCRIPT_SMOKE_BOOTSTRAP_INVALID".to_owned());
        }
        Ok(Some(request))
    }

    #[cfg(debug_assertions)]
    fn start_debug_files_smoke(app: &AppHandle, request: DebugFilesSmokeRequest) {
        let app = app.clone();
        std::thread::spawn(move || {
            let ready = (0..300).find_map(|_| {
                let state = app.try_state::<SidecarHost>()?;
                let transport = manuscript_host_session_transport(&state).ok();
                if transport.is_none() {
                    std::thread::park_timeout(Duration::from_millis(100));
                }
                transport
            });
            let Some((session, data_root)) = ready else {
                fail_host(&app, "MANUSCRIPT_SMOKE_SESSION_TIMEOUT");
                begin_or_replay_shutdown(&app);
                return;
            };
            let expected_root = request
                .result_path()
                .parent()
                .map(|parent| parent.join(format!(".mythpen-files-smoke-{}", request.run_id())));
            let cases = if expected_root.as_deref() == Some(data_root.as_path()) {
                let state = app.state::<SidecarHost>();
                debug_smoke_run_matrix(&state, &session, &data_root, &request)
            } else {
                Err("MANUSCRIPT_SMOKE_DATA_ROOT_MISMATCH".to_owned())
            };
            let cases = match cases {
                Ok(cases) => cases,
                Err(code) => {
                    eprintln!("[Files Smoke] fixed matrix failed: {code}");
                    debug_smoke_failed_cases(code)
                }
            };
            if let Err(code) = write_debug_smoke_result(&request, &session, cases) {
                eprintln!("[Files Smoke] result write failed: {code}");
            }
            begin_or_replay_shutdown(&app);
        });
    }

    #[cfg(debug_assertions)]
    fn prepare_debug_migration_preflight_smoke() -> Result<Option<DebugFilesSmokeRequest>, String> {
        let Some(nonce) = std::env::var_os("MYTHPEN_DESKTOP_MIGRATION_PREFLIGHT_SMOKE_NONCE")
        else {
            return Ok(None);
        };
        let nonce = nonce
            .into_string()
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_UNAUTHENTICATED".to_owned())?;
        let arguments = std::env::args_os().collect::<Vec<_>>();
        if arguments.len() != 2 {
            return Err("MIGRATION_PREFLIGHT_SMOKE_REQUEST_INVALID".to_owned());
        }
        let request_path = PathBuf::from(&arguments[1]);
        let request = load_migration_preflight_request(&request_path, &nonce)
            .map_err(|error| error.code().to_owned())?;
        claim_authenticated_request(&request).map_err(|error| error.code().to_owned())?;
        std::env::remove_var("MYTHPEN_DESKTOP_MIGRATION_PREFLIGHT_SMOKE_NONCE");
        if MIGRATION_PREFLIGHT_SMOKE_MARKER
            != "mythpen.desktop-l2-migration-preflight-smoke-bootstrap.v1"
        {
            return Err("MIGRATION_PREFLIGHT_SMOKE_BOOTSTRAP_INVALID".to_owned());
        }
        Ok(Some(request))
    }

    #[cfg(debug_assertions)]
    fn start_debug_migration_preflight_smoke(app: &AppHandle) {
        let app = app.clone();
        std::thread::spawn(move || {
            let ready = (0..300).find_map(|_| {
                let host = app.try_state::<SidecarHost>()?;
                let transport = manuscript_host_session_transport(&host).ok();
                if transport.is_none() {
                    std::thread::park_timeout(Duration::from_millis(100));
                }
                transport
            });
            let Some((session, data_root)) = ready else {
                fail_host(&app, "MIGRATION_PREFLIGHT_SMOKE_SESSION_TIMEOUT");
                begin_or_replay_shutdown(&app);
                return;
            };
            let state = app.state::<MigrationPreflightSmokeState>();
            if let Err(code) = state.prepare_fixture(&session, &data_root) {
                eprintln!("[Migration Preflight Smoke] fixture failed: {code}");
                fail_host(&app, "MIGRATION_PREFLIGHT_SMOKE_FIXTURE_FAILED");
                begin_or_replay_shutdown(&app);
                return;
            }
            let Some(run_id) = state.run_id() else {
                fail_host(&app, "MIGRATION_PREFLIGHT_SMOKE_INACTIVE");
                begin_or_replay_shutdown(&app);
                return;
            };
            for _ in 0..300 {
                if state.is_claimed() {
                    return;
                }
                let _ = app.emit(
                    "mythpen://migration-preflight-smoke",
                    serde_json::json!({ "runId": run_id }),
                );
                std::thread::park_timeout(Duration::from_millis(100));
            }
            fail_host(&app, "MIGRATION_PREFLIGHT_SMOKE_RENDERER_TIMEOUT");
            begin_or_replay_shutdown(&app);
        });
    }

    #[cfg(debug_assertions)]
    #[tauri::command]
    fn migration_preflight_smoke_active(state: State<'_, MigrationPreflightSmokeState>) -> bool {
        state.run_id().is_some()
    }

    #[cfg(debug_assertions)]
    #[tauri::command]
    fn claim_migration_preflight_smoke(
        state: State<'_, MigrationPreflightSmokeState>,
        run_id: String,
    ) -> Result<MigrationPreflightBootstrapBinding, String> {
        state.claim(&run_id)
    }

    #[cfg(debug_assertions)]
    #[tauri::command]
    fn migration_preflight_smoke_digest(
        host: State<'_, SidecarHost>,
        state: State<'_, MigrationPreflightSmokeState>,
        run_id: String,
    ) -> Result<String, String> {
        let inner = host
            .inner
            .lock()
            .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
        let _session = inner
            .session()
            .ok_or_else(|| "MANUSCRIPT_HOST_UNAUTHENTICATED".to_owned())?;
        state.digest(&run_id, &inner.data_root)
    }

    #[cfg(debug_assertions)]
    #[tauri::command]
    fn migration_preflight_smoke_begin(
        host: State<'_, SidecarHost>,
        state: State<'_, MigrationPreflightSmokeState>,
        run_id: String,
        request: MigrationPreflightRequest,
    ) -> Result<serde_json::Value, String> {
        let inner = host
            .inner
            .lock()
            .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
        let session = inner
            .session()
            .ok_or_else(|| "MANUSCRIPT_HOST_UNAUTHENTICATED".to_owned())?;
        state.begin(&run_id, request, &session)
    }

    #[cfg(debug_assertions)]
    #[tauri::command]
    fn complete_migration_preflight_smoke(
        app: AppHandle,
        host: State<'_, SidecarHost>,
        state: State<'_, MigrationPreflightSmokeState>,
        run_id: String,
        cases: Vec<MigrationPreflightSmokeCase>,
    ) -> Result<(), String> {
        {
            let inner = host
                .inner
                .lock()
                .map_err(|_| "SIDECAR_HOST_UNAVAILABLE".to_owned())?;
            let session = inner
                .session()
                .ok_or_else(|| "MANUSCRIPT_HOST_UNAUTHENTICATED".to_owned())?;
            state.complete(&run_id, cases, &session)?;
        }
        begin_or_replay_shutdown(&app);
        Ok(())
    }

    #[cfg(debug_assertions)]
    #[tauri::command]
    fn fail_migration_preflight_smoke(
        app: AppHandle,
        state: State<'_, MigrationPreflightSmokeState>,
        run_id: String,
        code: String,
    ) -> Result<(), String> {
        if state.run_id().as_deref() != Some(run_id.as_str()) {
            return Err("MIGRATION_PREFLIGHT_SMOKE_UNAUTHENTICATED".to_owned());
        }
        eprintln!("[Migration Preflight Smoke] renderer failed: {code}");
        fail_host(&app, "MIGRATION_PREFLIGHT_SMOKE_RENDERER_FAILED");
        begin_or_replay_shutdown(&app);
        Ok(())
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
            .invoke_handler({
                #[cfg(debug_assertions)]
                {
                    tauri::generate_handler![
                        get_sidecar_session,
                        open_manuscript_resource,
                        reveal_manuscript_project,
                        open_external_https,
                        request_shutdown,
                        cancel_shutdown,
                        continue_shutdown_wait,
                        emergency_exit,
                        migration_preflight_smoke_active,
                        claim_migration_preflight_smoke,
                        migration_preflight_smoke_digest,
                        migration_preflight_smoke_begin,
                        complete_migration_preflight_smoke,
                        fail_migration_preflight_smoke,
                    ]
                }
                #[cfg(not(debug_assertions))]
                {
                    tauri::generate_handler![
                        get_sidecar_session,
                        open_manuscript_resource,
                        reveal_manuscript_project,
                        open_external_https,
                        request_shutdown,
                        cancel_shutdown,
                        continue_shutdown_wait,
                        emergency_exit,
                    ]
                }
            })
            .setup(|app| {
                #[cfg(debug_assertions)]
                let debug_files_smoke = prepare_debug_files_smoke()
                    .map_err(|_| stable_io_error("MANUSCRIPT_SMOKE_BOOTSTRAP_FAILED"))?;
                #[cfg(debug_assertions)]
                let debug_migration_preflight = prepare_debug_migration_preflight_smoke()
                    .map_err(|_| stable_io_error("MIGRATION_PREFLIGHT_SMOKE_BOOTSTRAP_FAILED"))?;
                #[cfg(debug_assertions)]
                let start_migration_preflight = debug_migration_preflight.is_some();
                #[cfg(debug_assertions)]
                app.manage(MigrationPreflightSmokeState::new(debug_migration_preflight));
                spawn_owned_sidecar(app)?;
                #[cfg(debug_assertions)]
                if let Some(request) = debug_files_smoke {
                    start_debug_files_smoke(app.handle(), request);
                }
                #[cfg(debug_assertions)]
                if start_migration_preflight {
                    start_debug_migration_preflight_smoke(app.handle());
                }
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
