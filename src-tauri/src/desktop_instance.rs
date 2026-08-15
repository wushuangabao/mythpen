use tauri::{AppHandle, Manager, Runtime};

pub(crate) fn owned_sidecar_environment() -> [(&'static str, &'static str); 2] {
    [("MYTHPEN_DESKTOP_OWNED", "1"), ("PORT", "0")]
}

pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        eprintln!("[Desktop] second-instance focus failed: WINDOW_NOT_FOUND");
        return;
    };
    if window.show().is_err() {
        eprintln!("[Desktop] second-instance focus failed: SHOW_FAILED");
        return;
    }
    if window.is_minimized().unwrap_or(false) && window.unminimize().is_err() {
        eprintln!("[Desktop] second-instance focus failed: UNMINIMIZE_FAILED");
        return;
    }
    if window.set_focus().is_err() {
        eprintln!("[Desktop] second-instance focus failed: FOCUS_FAILED");
    }
}

#[cfg(test)]
mod tests {
    use super::owned_sidecar_environment;

    #[test]
    fn single_instance_plugin_is_registered_before_shell_and_setup() {
        let source = include_str!("lib.rs");
        let single = source
            .find("plugin(tauri_plugin_single_instance")
            .expect("single-instance plugin must be registered");
        let shell = source
            .find("plugin(tauri_plugin_shell")
            .expect("shell plugin must be registered");
        let setup = source.find(".setup(").expect("setup must be registered");

        assert!(single < shell);
        assert!(single < setup);
    }

    #[test]
    fn desktop_sidecar_runtime_is_cfg_isolated_from_the_mobile_run_path() {
        let source = include_str!("lib.rs");
        let desktop_module = source
            .find(
                "#[cfg(not(any(target_os = \"android\", target_os = \"ios\")))]\nmod desktop_runtime",
            )
            .expect("desktop runtime must use the same cfg as its desktop-only dependency");
        let single_instance = source
            .find("plugin(tauri_plugin_single_instance")
            .expect("desktop run must register single instance");
        let desktop_run = source
            .rfind("#[cfg(not(any(target_os = \"android\", target_os = \"ios\")))]\npub fn run()")
            .expect("desktop run wrapper must be cfg isolated");
        let mobile_run = source
            .rfind("#[cfg(any(target_os = \"android\", target_os = \"ios\"))]")
            .expect("mobile run path must remain compilable without desktop plugins");

        assert!(desktop_module < single_instance);
        assert!(single_instance < desktop_run);
        assert!(desktop_run < mobile_run);
        assert_eq!(source.matches("pub fn run()").count(), 2);
    }

    #[test]
    fn owned_sidecar_launch_projection_has_only_marker_and_dynamic_port() {
        assert_eq!(
            owned_sidecar_environment(),
            [("MYTHPEN_DESKTOP_OWNED", "1"), ("PORT", "0"),]
        );
    }

    #[test]
    fn tauri_runtime_keeps_receiver_and_uses_preventable_lifecycle_events() {
        let source = include_str!("lib.rs");
        for forbidden in [
            "wait_for_server",
            concat!("request_graceful_", "shutdown"),
            "TcpStream",
            "thread::sleep",
            concat!("127.0.0.1:", "3001"),
            "let (_rx, child)",
            concat!("/api/", "shutdown"),
        ] {
            assert!(
                !source.contains(forbidden),
                "legacy lifecycle residue: {forbidden}"
            );
        }
        for required in [
            "CommandEvent::Stdout",
            "CommandEvent::Stderr",
            "CommandEvent::Terminated",
            "get_sidecar_session",
            "request_shutdown",
            "cancel_shutdown",
            "continue_shutdown_wait",
            "emergency_exit",
            "api.prevent_close()",
            "api.prevent_exit()",
        ] {
            assert!(
                source.contains(required),
                "missing owned lifecycle path: {required}"
            );
        }
    }
}
