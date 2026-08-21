#[cfg(debug_assertions)]
use app_lib::manuscript_files::debug_files_smoke::{
    claim_authenticated_request, load_authenticated_request, load_migration_preflight_request,
    DEBUG_FILES_SMOKE_CASE_IDS, DEBUG_FILES_SMOKE_MARKER,
};
use app_lib::manuscript_files::{
    open_allowed_external_https, open_manuscript_resource,
    resolve_authenticated_open_manuscript_resource, resolve_authenticated_sidecar_project_session,
    resolve_manuscript_project_root, resolve_manuscript_resource, reveal_manuscript_project,
    AuthenticatedManuscriptSession, ExternalHttpsLauncher, ManuscriptFileLauncher,
    ManuscriptProjectRoute, ManuscriptResourceKind, ManuscriptResourceRequest,
};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const PROJECT_UID: &str = "11111111-1111-4111-8111-111111111111";
const INSTANCE_UID: &str = "22222222-2222-4222-8222-222222222222";
const VOLUME_UID: &str = "33333333-3333-4333-8333-333333333333";
const CHAPTER_UID: &str = "44444444-4444-4444-8444-444444444444";
const UNKNOWN_UID: &str = "55555555-5555-4555-8555-555555555555";

static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
struct Session {
    data_root: PathBuf,
    project_uid: String,
    instance_uid: String,
    route: ManuscriptProjectRoute,
}

impl AuthenticatedManuscriptSession for Session {
    fn canonical_data_root(&self) -> &Path {
        &self.data_root
    }

    fn project_uid(&self) -> &str {
        &self.project_uid
    }

    fn project_instance_uid(&self) -> &str {
        &self.instance_uid
    }

    fn route(&self) -> ManuscriptProjectRoute {
        self.route
    }
}

#[derive(Default)]
struct RecordingLauncher {
    opened: Mutex<Vec<PathBuf>>,
    revealed: Mutex<Vec<PathBuf>>,
}

impl ExternalHttpsLauncher for RecordingLauncher {
    fn open_external_https(&self, url: &str) -> Result<(), String> {
        self.opened.lock().unwrap().push(PathBuf::from(url));
        Ok(())
    }
}

impl ManuscriptFileLauncher for RecordingLauncher {
    fn open(&self, path: &Path) -> Result<(), String> {
        self.opened.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }

    fn reveal(&self, path: &Path) -> Result<(), String> {
        self.revealed.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
    article_root: PathBuf,
    volume_path: PathBuf,
    body_path: PathBuf,
    sidecar_path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "mythpen-host-files-{}-{sequence}",
            std::process::id()
        ));
        let article_root = root.join("manuscripts").join(PROJECT_UID);
        let mythpen_root = article_root.join("mythpen");
        let volumes_root = mythpen_root.join("volumes");
        let chapters_root = mythpen_root.join("chapters");
        fs::create_dir_all(&volumes_root).unwrap();
        fs::create_dir_all(&chapters_root).unwrap();

        fs::write(
            mythpen_root.join("manuscript.json"),
            format!(
                "{{\"format_version\":1,\"project_uid\":\"{PROJECT_UID}\",\"volume_uids\":[\"{VOLUME_UID}\"]}}\n"
            ),
        )
        .unwrap();
        fs::write(
            mythpen_root.join("unassigned.json"),
            "{\"format_version\":1,\"kind\":\"unassigned\",\"chapter_uids\":[]}\n",
        )
        .unwrap();
        let volume_path = volumes_root.join(format!("vol_{VOLUME_UID}.json"));
        fs::write(
            &volume_path,
            format!(
                "{{\"format_version\":1,\"volume_uid\":\"{VOLUME_UID}\",\"title\":\"V\",\"summary\":\"\",\"chapter_uids\":[\"{CHAPTER_UID}\"]}}\n"
            ),
        )
        .unwrap();
        let body_path = chapters_root.join(format!("ch_{CHAPTER_UID}.md"));
        fs::write(&body_path, "chapter body\n").unwrap();
        let sidecar_path = chapters_root.join(format!("ch_{CHAPTER_UID}.json"));
        fs::write(
            &sidecar_path,
            format!(
                "{{\"format_version\":1,\"chapter_uid\":\"{CHAPTER_UID}\",\"title\":\"C\",\"outline\":\"\",\"status\":\"pending\",\"summary\":\"\",\"cognitive_frame\":\"\",\"emotional_anchor\":\"\",\"world_texture\":\"\",\"concrete_mystery\":\"\",\"interpersonal_tension\":\"\"}}\n"
            ),
        )
        .unwrap();

        Self {
            root,
            article_root,
            volume_path,
            body_path,
            sidecar_path,
        }
    }

    fn session(&self) -> Session {
        Session {
            data_root: self.root.clone(),
            project_uid: PROJECT_UID.to_owned(),
            instance_uid: INSTANCE_UID.to_owned(),
            route: ManuscriptProjectRoute::Files,
        }
    }

    fn request(&self, kind: ManuscriptResourceKind, uid: &str) -> ManuscriptResourceRequest {
        ManuscriptResourceRequest::new(PROJECT_UID, INSTANCE_UID, kind, uid).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn assert_code<T: std::fmt::Debug>(result: Result<T, impl std::fmt::Debug>, expected: &str) {
    let error = result.expect_err("request must fail closed");
    assert!(
        format!("{error:?}").contains(expected),
        "expected {expected}, got {error:?}"
    );
}

#[cfg(debug_assertions)]
#[test]
fn debug_files_smoke_request_is_nonce_bound_path_derived_and_matrix_is_fixed() {
    use sha2::{Digest, Sha256};

    let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "mythpen-host-smoke-request-{}-{sequence}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let run_id = "12345678-1234-4234-8234-123456789abc";
    let nonce = "ab".repeat(32);
    let result_path = root.join("files-result.json");
    let sidecar_path = root.join("mythpen-server.exe");
    fs::write(&sidecar_path, b"sidecar").unwrap();
    let request_path = root.join(format!(".files-result.{run_id}.request.json"));
    let mut wire = serde_json::json!({
        "version": 1,
        "type": "mythpen.desktop-l2-files-smoke-request.v1",
        "runId": run_id,
        "nonceSha256": hex::encode(Sha256::digest(nonce.as_bytes())),
        "resultPath": result_path,
        "sidecarPath": sidecar_path,
    });
    fs::write(&request_path, serde_json::to_vec(&wire).unwrap()).unwrap();

    let request = load_authenticated_request(&request_path, &nonce).unwrap();
    assert_eq!(request.run_id(), run_id);
    assert_eq!(request.result_path(), result_path.as_path());
    assert_eq!(request.sidecar_path(), sidecar_path.as_path());
    claim_authenticated_request(&request).unwrap();
    assert_eq!(
        claim_authenticated_request(&request).unwrap_err().code(),
        "MANUSCRIPT_SMOKE_REQUEST_CONSUMED"
    );
    assert_eq!(
        DEBUG_FILES_SMOKE_CASE_IDS,
        [
            "open_chapter_body",
            "open_chapter_sidecar",
            "open_volume_index",
            "reveal_project",
            "unknown_uid_rejected",
            "wrong_route_rejected",
            "hard_link_rejected",
            "reparse_alias_rejected",
        ]
    );
    assert_eq!(
        DEBUG_FILES_SMOKE_MARKER,
        "mythpen.desktop-l2-files-smoke-bootstrap.v1"
    );

    wire["cases"] = serde_json::json!(["caller-defined"]);
    fs::write(&request_path, serde_json::to_vec(&wire).unwrap()).unwrap();
    assert_eq!(
        load_authenticated_request(&request_path, &nonce)
            .unwrap_err()
            .code(),
        "MANUSCRIPT_SMOKE_REQUEST_INVALID"
    );

    wire.as_object_mut().unwrap().remove("cases");
    wire["nonceSha256"] = serde_json::Value::String("00".repeat(32));
    fs::write(&request_path, serde_json::to_vec(&wire).unwrap()).unwrap();
    assert_eq!(
        load_authenticated_request(&request_path, &nonce)
            .unwrap_err()
            .code(),
        "MANUSCRIPT_SMOKE_UNAUTHENTICATED"
    );
    fs::remove_dir_all(&root).unwrap();
}

#[cfg(debug_assertions)]
#[test]
fn migration_preflight_smoke_request_uses_a_distinct_authenticated_type() {
    use sha2::{Digest, Sha256};

    let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "mythpen-host-preflight-request-{}-{sequence}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let run_id = "87654321-4321-4321-8321-cba987654321";
    let nonce = "cd".repeat(32);
    let result_path = root.join("preflight-result.json");
    let sidecar_path = root.join("mythpen-server.exe");
    fs::write(&sidecar_path, b"sidecar").unwrap();
    let request_path = root.join(format!(".preflight-result.{run_id}.request.json"));
    let wire = serde_json::json!({
        "version": 1,
        "type": "mythpen.desktop-l2-migration-preflight-smoke-request.v1",
        "runId": run_id,
        "nonceSha256": hex::encode(Sha256::digest(nonce.as_bytes())),
        "resultPath": result_path,
        "sidecarPath": sidecar_path,
    });
    fs::write(&request_path, serde_json::to_vec(&wire).unwrap()).unwrap();

    let request = load_migration_preflight_request(&request_path, &nonce).unwrap();
    assert_eq!(request.run_id(), run_id);
    assert_eq!(request.result_path(), result_path.as_path());
    assert_eq!(request.sidecar_path(), sidecar_path.as_path());
    assert_eq!(
        load_authenticated_request(&request_path, &nonce)
            .unwrap_err()
            .code(),
        "MANUSCRIPT_SMOKE_REQUEST_INVALID"
    );
    claim_authenticated_request(&request).unwrap();
    assert_eq!(
        claim_authenticated_request(&request).unwrap_err().code(),
        "MANUSCRIPT_SMOKE_REQUEST_CONSUMED"
    );

    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn authenticated_files_session_resolves_only_uid_derived_controlled_resources() {
    let fixture = Fixture::new();
    let session = fixture.session();

    let volume = resolve_manuscript_resource(
        Some(&session),
        &fixture.request(ManuscriptResourceKind::VolumeIndex, VOLUME_UID),
    )
    .unwrap();
    assert_eq!(volume.path(), fixture.volume_path);

    let body = resolve_manuscript_resource(
        Some(&session),
        &fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID),
    )
    .unwrap();
    assert_eq!(body.path(), fixture.body_path);

    let sidecar = resolve_manuscript_resource(
        Some(&session),
        &fixture.request(ManuscriptResourceKind::ChapterSidecar, CHAPTER_UID),
    )
    .unwrap();
    assert_eq!(sidecar.path(), fixture.sidecar_path);

    let project =
        resolve_manuscript_project_root(Some(&session), PROJECT_UID, INSTANCE_UID).unwrap();
    assert_eq!(project.path(), fixture.article_root);
}

#[test]
fn unauthenticated_route_mismatch_and_stale_instance_fail_before_resolution() {
    let fixture = Fixture::new();
    let request = fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID);
    assert_code(
        resolve_manuscript_resource(None, &request),
        "MANUSCRIPT_HOST_UNAUTHENTICATED",
    );

    for route in [
        ManuscriptProjectRoute::Sqlite,
        ManuscriptProjectRoute::Migrating,
        ManuscriptProjectRoute::Retired,
    ] {
        let mut session = fixture.session();
        session.route = route;
        assert_code(
            resolve_manuscript_resource(Some(&session), &request),
            "MANUSCRIPT_PROJECT_ROUTE_MISMATCH",
        );
    }

    let mut stale = fixture.session();
    stale.instance_uid = UNKNOWN_UID.to_owned();
    assert_code(
        resolve_manuscript_resource(Some(&stale), &request),
        "MANUSCRIPT_PROJECT_INSTANCE_STALE",
    );
}

#[test]
fn unknown_uid_missing_file_and_uid_mismatch_fail_closed() {
    let fixture = Fixture::new();
    let session = fixture.session();

    assert_code(
        resolve_manuscript_resource(
            Some(&session),
            &fixture.request(ManuscriptResourceKind::ChapterBody, UNKNOWN_UID),
        ),
        "MANUSCRIPT_RESOURCE_UNKNOWN_UID",
    );

    fs::remove_file(&fixture.body_path).unwrap();
    assert_code(
        resolve_manuscript_resource(
            Some(&session),
            &fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID),
        ),
        "MANUSCRIPT_RESOURCE_NOT_FOUND",
    );

    fs::write(
        &fixture.volume_path,
        format!(
            "{{\"format_version\":1,\"volume_uid\":\"{UNKNOWN_UID}\",\"title\":\"V\",\"summary\":\"\",\"chapter_uids\":[\"{CHAPTER_UID}\"]}}\n"
        ),
    )
    .unwrap();
    assert_code(
        resolve_manuscript_resource(
            Some(&session),
            &fixture.request(ManuscriptResourceKind::VolumeIndex, VOLUME_UID),
        ),
        "MANUSCRIPT_RESOURCE_UID_MISMATCH",
    );
}

#[test]
fn hard_links_and_noncanonical_roots_are_rejected() {
    let fixture = Fixture::new();
    let session = fixture.session();
    let extra_link = fixture.root.join("external-hard-link.md");
    fs::hard_link(&fixture.body_path, &extra_link).unwrap();
    assert_code(
        resolve_manuscript_resource(
            Some(&session),
            &fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID),
        ),
        "MANUSCRIPT_RESOURCE_HARD_LINK",
    );

    let mut noncanonical = fixture.session();
    noncanonical.data_root = fixture.root.join("child").join("..");
    assert_code(
        resolve_manuscript_resource(
            Some(&noncanonical),
            &fixture.request(ManuscriptResourceKind::VolumeIndex, VOLUME_UID),
        ),
        "MANUSCRIPT_DATA_ROOT_INVALID",
    );
}

#[cfg(windows)]
#[test]
fn windows_junction_alias_cannot_escape_the_article_root() {
    use std::process::Command;

    let fixture = Fixture::new();
    let outside = fixture.root.join("outside");
    let outside_chapters = outside.join("chapters");
    fs::create_dir_all(&outside_chapters).unwrap();
    fs::write(
        outside_chapters.join(format!("ch_{CHAPTER_UID}.md")),
        "outside\n",
    )
    .unwrap();
    fs::write(
        outside_chapters.join(format!("ch_{CHAPTER_UID}.json")),
        format!("{{\"format_version\":1,\"chapter_uid\":\"{CHAPTER_UID}\"}}\n"),
    )
    .unwrap();

    let chapters = fixture.article_root.join("mythpen").join("chapters");
    fs::remove_dir_all(&chapters).unwrap();
    let status = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(&chapters)
        .arg(&outside_chapters)
        .status()
        .unwrap();
    assert!(status.success(), "junction fixture must be available");

    let session = fixture.session();
    assert_code(
        resolve_manuscript_resource(
            Some(&session),
            &fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID),
        ),
        "MANUSCRIPT_RESOURCE_REPARSE_POINT",
    );
    fs::remove_dir(&chapters).unwrap();
}

#[cfg(unix)]
#[test]
fn unix_symlink_alias_cannot_escape_the_article_root() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let outside = fixture.root.join("outside");
    let outside_chapters = outside.join("chapters");
    fs::create_dir_all(&outside_chapters).unwrap();
    let chapters = fixture.article_root.join("mythpen").join("chapters");
    fs::remove_dir_all(&chapters).unwrap();
    symlink(&outside_chapters, &chapters).unwrap();

    let session = fixture.session();
    assert_code(
        resolve_manuscript_resource(
            Some(&session),
            &fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID),
        ),
        "MANUSCRIPT_RESOURCE_REPARSE_POINT",
    );
    fs::remove_file(&chapters).unwrap();
}

#[test]
fn launcher_receives_only_the_host_resolved_path() {
    let fixture = Fixture::new();
    let session = fixture.session();
    let launcher = RecordingLauncher::default();
    let request = fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID);

    open_manuscript_resource(Some(&session), &request, &launcher).unwrap();
    reveal_manuscript_project(Some(&session), PROJECT_UID, INSTANCE_UID, &launcher).unwrap();

    assert_eq!(
        *launcher.opened.lock().unwrap(),
        vec![fixture.body_path.clone()]
    );
    assert_eq!(
        *launcher.revealed.lock().unwrap(),
        vec![fixture.article_root.clone()]
    );
}

#[test]
fn sidecar_route_session_is_resolved_over_the_authenticated_nonce_channel() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let nonce = "ab".repeat(32);
    let expected_nonce = nonce.clone();
    let server = std::thread::spawn(move || {
        for (index, expected_target) in [
            "/api/projects",
            "/api/projects/by-name/Novel%20%E5%90%8D/files-beta/status",
        ]
        .iter()
        .enumerate()
        {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with(&format!("GET {expected_target} HTTP/1.1\r\n")));
            assert!(request.contains(&format!(
                "\r\nX-Mythpen-Instance-Nonce: {expected_nonce}\r\n"
            )));
            let body = if index == 0 {
                "[{\"name\":\"Novel 名\",\"manuscriptRoute\":\"files\"}]".to_owned()
            } else {
                format!(
                    "{{\"route\":\"files\",\"project_uid\":\"{PROJECT_UID}\",\"project_instance_id\":\"{INSTANCE_UID}\"}}"
                )
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });

    let session = resolve_authenticated_sidecar_project_session(
        &fixture.root,
        port,
        &nonce,
        PROJECT_UID,
        INSTANCE_UID,
    )
    .unwrap();
    assert_eq!(session.project_uid(), PROJECT_UID);
    assert_eq!(session.project_instance_uid(), INSTANCE_UID);
    assert_eq!(session.route(), ManuscriptProjectRoute::Files);
    server.join().unwrap();
}

#[test]
fn sidecar_route_session_rejects_an_invalid_nonce_before_connecting() {
    let fixture = Fixture::new();
    assert_code(
        resolve_authenticated_sidecar_project_session(
            &fixture.root,
            1,
            "renderer-value",
            PROJECT_UID,
            INSTANCE_UID,
        ),
        "MANUSCRIPT_HOST_UNAUTHENTICATED",
    );
}

#[test]
fn external_https_command_accepts_only_the_fixed_about_url() {
    let launcher = RecordingLauncher::default();
    open_allowed_external_https("https://github.com/niyongsheng/mythpen", &launcher).unwrap();
    assert_code(
        open_allowed_external_https("https://github.com/niyongsheng/mythpen/issues", &launcher),
        "EXTERNAL_HTTPS_URL_DENIED",
    );
    assert_code(
        open_allowed_external_https("file:///C:/Windows/System32", &launcher),
        "EXTERNAL_HTTPS_URL_DENIED",
    );
    assert_eq!(
        *launcher.opened.lock().unwrap(),
        vec![PathBuf::from("https://github.com/niyongsheng/mythpen")]
    );
}

#[test]
fn production_open_rechecks_route_and_instance_immediately_before_launch() {
    let fixture = Fixture::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let nonce = "cd".repeat(32);
    let server = std::thread::spawn(move || {
        for index in 0..4 {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 2048];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..count]);
                if count == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let body = if index % 2 == 0 {
                "[{\"name\":\"Route race\",\"manuscriptRoute\":\"files\"}]".to_owned()
            } else {
                let route = if index == 1 { "files" } else { "retired" };
                format!(
                    "{{\"route\":\"{route}\",\"project_uid\":\"{PROJECT_UID}\",\"project_instance_id\":\"{INSTANCE_UID}\"}}"
                )
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let request = fixture.request(ManuscriptResourceKind::ChapterBody, CHAPTER_UID);
    assert_code(
        resolve_authenticated_open_manuscript_resource(&fixture.root, port, &nonce, &request),
        "MANUSCRIPT_PROJECT_ROUTE_MISMATCH",
    );
    server.join().unwrap();
}
