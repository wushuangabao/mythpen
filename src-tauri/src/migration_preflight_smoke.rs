#![cfg(debug_assertions)]

use crate::manuscript_files::debug_files_smoke::{
    sidecar_json_request, DebugFilesSmokeRequest, DebugSidecarJsonRequest,
};
use crate::sidecar_protocol::SidecarSession;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

pub(crate) const MARKER: &str = "mythpen.desktop-l2-migration-preflight-smoke-bootstrap.v1";
#[used]
pub static BINARY_MARKER: [u8; 58] =
    *b"mythpen.desktop-l2-migration-preflight-smoke-bootstrap.v1\0";
const CASE_IDS: [&str; 8] = [
    "unresolved_body",
    "unresolved_sidecar",
    "unresolved_volume_metadata",
    "unresolved_structure",
    "unloaded_queue",
    "stale_multi_window_epoch",
    "non_responsive_window",
    "all_persisted_or_explicitly_resolved",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BootstrapBinding {
    run_id: String,
    project_name: String,
    project_instance_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MigrationRequest {
    project_name: String,
    project_instance_id: String,
    request_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SmokeCase {
    id: String,
    status: String,
    api_calls: usize,
    service_calls: usize,
    before_digest: String,
    after_digest: String,
}

struct Inner {
    request: Option<DebugFilesSmokeRequest>,
    project_name: Option<String>,
    project_instance_id: Option<String>,
    claimed: bool,
    completed: bool,
    api_calls: usize,
}

pub(crate) struct State {
    inner: Mutex<Inner>,
}

impl State {
    pub(crate) fn new(request: Option<DebugFilesSmokeRequest>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                request,
                project_name: None,
                project_instance_id: None,
                claimed: false,
                completed: false,
                api_calls: 0,
            }),
        }
    }

    pub(crate) fn run_id(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|inner| {
            inner
                .request
                .as_ref()
                .map(|request| request.run_id().to_owned())
        })
    }

    pub(crate) fn is_claimed(&self) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.claimed)
            .unwrap_or(false)
    }

    pub(crate) fn prepare_fixture(
        &self,
        session: &SidecarSession,
        data_root: &Path,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_STATE_INVALID".to_owned())?;
        let request = inner
            .request
            .as_ref()
            .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_INACTIVE".to_owned())?;
        let parent = request
            .result_path()
            .parent()
            .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_DATA_ROOT_INVALID".to_owned())?;
        let expected_root = parent.join(format!(".mythpen-preflight-smoke-{}", request.run_id()));
        if expected_root != data_root {
            return Err("MIGRATION_PREFLIGHT_SMOKE_DATA_ROOT_INVALID".to_owned());
        }
        let project_name = format!("desktop-preflight-smoke-{}", request.run_id());
        let created = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: "/api/projects",
                request_id: None,
                project_instance_uid: None,
                body: Some(&serde_json::json!({
                    "name": project_name,
                    "mode": "medium-novel",
                    "language": "zh",
                    "genres": ["other"],
                })),
                expected_status: 200,
            },
        )?;
        let project_instance_id = created
            .get("instanceId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| canonical_uuid_v4(value))
            .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_FIXTURE_INVALID".to_owned())?
            .to_owned();
        let activation_target = format!(
            "/api/projects/by-name/{}/durability/native",
            percent_encode_segment(&project_name)
        );
        let activated = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: &activation_target,
                request_id: None,
                project_instance_uid: Some(&project_instance_id),
                body: Some(&serde_json::json!({})),
                expected_status: 200,
            },
        )?;
        if activated
            .get("activated")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
            || activated.get("backend").and_then(serde_json::Value::as_str) != Some("native")
            || activated
                .get("schemaVersion")
                .and_then(serde_json::Value::as_u64)
                != Some(11)
            || activated.get("name").and_then(serde_json::Value::as_str)
                != Some(project_name.as_str())
        {
            return Err("MIGRATION_PREFLIGHT_SMOKE_FIXTURE_INVALID".to_owned());
        }
        inner.project_name = Some(project_name);
        inner.project_instance_id = Some(project_instance_id);
        Ok(())
    }

    pub(crate) fn claim(&self, run_id: &str) -> Result<BootstrapBinding, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_STATE_INVALID".to_owned())?;
        let request = exact_request(&inner, run_id)?;
        if inner.claimed || inner.completed {
            return Err("MIGRATION_PREFLIGHT_SMOKE_CONSUMED".to_owned());
        }
        let project_name = inner
            .project_name
            .clone()
            .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_FIXTURE_PENDING".to_owned())?;
        let project_instance_id = inner
            .project_instance_id
            .clone()
            .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_FIXTURE_PENDING".to_owned())?;
        let request_run_id = request.run_id().to_owned();
        inner.claimed = true;
        Ok(BootstrapBinding {
            run_id: request_run_id,
            project_name,
            project_instance_id,
        })
    }

    pub(crate) fn digest(&self, run_id: &str, data_root: &Path) -> Result<String, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_STATE_INVALID".to_owned())?;
        exact_request(&inner, run_id)?;
        if !inner.claimed || inner.completed {
            return Err("MIGRATION_PREFLIGHT_SMOKE_INACTIVE".to_owned());
        }
        digest_tree(data_root)
    }

    pub(crate) fn begin(
        &self,
        run_id: &str,
        request: MigrationRequest,
        session: &SidecarSession,
    ) -> Result<serde_json::Value, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_STATE_INVALID".to_owned())?;
        exact_request(&inner, run_id)?;
        if !inner.claimed || inner.completed || inner.api_calls != 0 {
            return Err("MIGRATION_PREFLIGHT_SMOKE_ADMISSION_INVALID".to_owned());
        }
        if inner.project_name.as_deref() != Some(request.project_name.as_str())
            || inner.project_instance_id.as_deref() != Some(request.project_instance_id.as_str())
            || !canonical_uuid_v4(&request.request_id)
        {
            return Err("MIGRATION_PREFLIGHT_SMOKE_ADMISSION_INVALID".to_owned());
        }
        inner.api_calls += 1;
        let target = format!(
            "/api/projects/by-name/{}/files-beta/migrate",
            percent_encode_segment(&request.project_name)
        );
        let response = sidecar_json_request(
            session.port,
            &session.nonce,
            DebugSidecarJsonRequest {
                method: "POST",
                target: &target,
                request_id: Some(&request.request_id),
                project_instance_uid: None,
                body: Some(&serde_json::json!({})),
                expected_status: 200,
            },
        )?;
        if response.get("state").and_then(serde_json::Value::as_str) != Some("activated")
            || !response
                .get("migrationId")
                .and_then(serde_json::Value::as_str)
                .is_some_and(canonical_uuid_v4)
        {
            return Err("MIGRATION_PREFLIGHT_SMOKE_MIGRATION_INVALID".to_owned());
        }
        Ok(response)
    }

    pub(crate) fn complete(
        &self,
        run_id: &str,
        cases: Vec<SmokeCase>,
        session: &SidecarSession,
    ) -> Result<(), String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_STATE_INVALID".to_owned())?;
        let request = exact_request(&inner, run_id)?;
        if !inner.claimed || inner.completed || inner.api_calls != 1 {
            return Err("MIGRATION_PREFLIGHT_SMOKE_RESULT_INVALID".to_owned());
        }
        validate_cases(&cases)?;
        write_result(request, session, &cases)?;
        inner.completed = true;
        Ok(())
    }
}

fn exact_request<'a>(inner: &'a Inner, run_id: &str) -> Result<&'a DebugFilesSmokeRequest, String> {
    let request = inner
        .request
        .as_ref()
        .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_INACTIVE".to_owned())?;
    if request.run_id() != run_id {
        return Err("MIGRATION_PREFLIGHT_SMOKE_UNAUTHENTICATED".to_owned());
    }
    Ok(request)
}

fn validate_cases(cases: &[SmokeCase]) -> Result<(), String> {
    if cases.len() != CASE_IDS.len() {
        return Err("MIGRATION_PREFLIGHT_SMOKE_RESULT_INVALID".to_owned());
    }
    for (index, case) in cases.iter().enumerate() {
        let positive = index + 1 == CASE_IDS.len();
        if case.id != CASE_IDS[index]
            || case.status != "PASS"
            || (positive && (case.api_calls != 1 || case.service_calls != 1))
            || (!positive && (case.api_calls != 0 || case.service_calls != 0))
            || (!positive && case.before_digest != case.after_digest)
            || (positive && case.before_digest == case.after_digest)
            || !lower_sha256(&case.before_digest)
            || !lower_sha256(&case.after_digest)
        {
            eprintln!(
                "[Migration Preflight Smoke] invalid case index={index} id={} status={} apiCalls={} serviceCalls={} beforeDigest={} afterDigest={}",
                case.id,
                case.status,
                case.api_calls,
                case.service_calls,
                case.before_digest,
                case.after_digest
            );
            return Err("MIGRATION_PREFLIGHT_SMOKE_RESULT_INVALID".to_owned());
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactIdentity {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Serialize)]
struct Auth {
    mode: &'static str,
}

#[derive(Serialize)]
struct Suite {
    total: usize,
    passed: usize,
    failed: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultWire<'a> {
    version: u8,
    #[serde(rename = "type")]
    result_type: &'static str,
    status: &'static str,
    source_commit: &'a str,
    target_triple: &'a str,
    desktop: ArtifactIdentity,
    sidecar: ArtifactIdentity,
    auth: Auth,
    run_id: &'a str,
    request: ArtifactIdentity,
    suite: Suite,
    cases: &'a [SmokeCase],
}

fn write_result(
    request: &DebugFilesSmokeRequest,
    session: &SidecarSession,
    cases: &[SmokeCase],
) -> Result<(), String> {
    let desktop_path = std::env::current_exe()
        .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned())?;
    let actual_sidecar_path = desktop_path
        .parent()
        .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned())?
        .join(if cfg!(windows) {
            "mythpen-server.exe"
        } else {
            "mythpen-server"
        });
    let actual_sidecar = artifact_identity(&actual_sidecar_path)?;
    let requested_sidecar = artifact_identity(request.sidecar_path())?;
    if actual_sidecar.bytes != requested_sidecar.bytes
        || actual_sidecar.sha256 != requested_sidecar.sha256
    {
        return Err("MIGRATION_PREFLIGHT_SMOKE_SIDECAR_MISMATCH".to_owned());
    }
    let request_identity = ArtifactIdentity {
        path: path_string(request.request_path())?,
        bytes: request.request_bytes().len() as u64,
        sha256: hex::encode(Sha256::digest(request.request_bytes())),
    };
    let result = ResultWire {
        version: 1,
        result_type: "mythpen.desktop-l2-migration-preflight-smoke.v1",
        status: "PASS",
        source_commit: &session.build_info.source_commit,
        target_triple: &session.build_info.target_triple,
        desktop: artifact_identity(&desktop_path)?,
        sidecar: requested_sidecar,
        auth: Auth {
            mode: "debug-only-one-time-nonce-v1",
        },
        run_id: request.run_id(),
        request: request_identity,
        suite: Suite {
            total: CASE_IDS.len(),
            passed: CASE_IDS.len(),
            failed: 0,
        },
        cases,
    };
    let mut bytes = serde_json::to_vec(&result)
        .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_RESULT_INVALID".to_owned())?;
    bytes.push(b'\n');
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(request.result_path())
        .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_RESULT_CREATE_FAILED".to_owned())?;
    output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_RESULT_WRITE_FAILED".to_owned())
}

fn artifact_identity(path: &Path) -> Result<ArtifactIdentity, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned())?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err("MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned());
    }
    Ok(ArtifactIdentity {
        path: path_string(path)?,
        bytes: metadata.len(),
        sha256: hash_file(path)?,
    })
}

fn digest_tree(root: &Path) -> Result<String, String> {
    let metadata =
        fs::symlink_metadata(root).map_err(|error| digest_failure("root-metadata", root, error))?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        eprintln!(
            "[Migration Preflight Smoke] digest root is not an ordinary directory: {}",
            root.display()
        );
        return Err("MIGRATION_PREFLIGHT_SMOKE_DIGEST_FAILED".to_owned());
    }
    let mut hasher = Sha256::new();
    hasher.update(b"mythpen-migration-preflight-product-state-v1\0");
    for name in ["config.db", "control", "locks", "manuscripts", "projects"] {
        digest_node(root, &root.join(name), &mut hasher)?;
    }
    Ok(hex::encode(hasher.finalize()))
}

fn digest_node(root: &Path, path: &Path, hasher: &mut Sha256) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|error| digest_failure("strip-prefix", path, error))?;
    let relative_text = relative.to_str().ok_or_else(|| {
        eprintln!(
            "[Migration Preflight Smoke] digest path is not UTF-8: {}",
            path.display()
        );
        "MIGRATION_PREFLIGHT_SMOKE_DIGEST_FAILED".to_owned()
    })?;
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            hash_entry_header(hasher, b'A', relative_text, 0);
            return Ok(());
        }
        Err(error) => return Err(digest_failure("metadata", path, error)),
    };
    if is_reparse(&metadata) {
        eprintln!(
            "[Migration Preflight Smoke] digest rejected reparse path: {}",
            path.display()
        );
        return Err("MIGRATION_PREFLIGHT_SMOKE_DIGEST_FAILED".to_owned());
    }
    if metadata.is_dir() {
        hash_entry_header(hasher, b'D', relative_text, 0);
        let mut entries = fs::read_dir(path)
            .map_err(|error| digest_failure("read-dir", path, error))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| digest_failure("read-dir-entry", path, error))?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            digest_node(root, &entry.path(), hasher)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        eprintln!(
            "[Migration Preflight Smoke] digest rejected non-file path: {}",
            path.display()
        );
        return Err("MIGRATION_PREFLIGHT_SMOKE_DIGEST_FAILED".to_owned());
    }
    hash_entry_header(hasher, b'F', relative_text, metadata.len());
    if expected_empty_held_lock(relative) {
        if metadata.len() != 0 {
            eprintln!(
                "[Migration Preflight Smoke] held lock is not empty: {}",
                path.display()
            );
            return Err("MIGRATION_PREFLIGHT_SMOKE_DIGEST_FAILED".to_owned());
        }
        return Ok(());
    }
    let mut file =
        fs::File::open(path).map_err(|error| digest_failure("open-file", path, error))?;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| digest_failure("read-file", path, error))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(())
}

fn expected_empty_held_lock(relative: &Path) -> bool {
    relative
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|name| {
            name.ends_with(".lifecycle.lock") || name == ".controlstore-writer.lock"
        })
        || (relative.parent() == Some(Path::new("locks"))
            && relative.extension().and_then(|value| value.to_str()) == Some("lease"))
}

fn digest_failure(stage: &str, path: &Path, error: impl std::fmt::Display) -> String {
    eprintln!(
        "[Migration Preflight Smoke] digest {stage} failed for {}: {error}",
        path.display()
    );
    "MIGRATION_PREFLIGHT_SMOKE_DIGEST_FAILED".to_owned()
}

fn hash_entry_header(hasher: &mut Sha256, kind: u8, relative: &str, bytes: u64) {
    hasher.update([kind]);
    hasher.update((relative.len() as u64).to_le_bytes());
    hasher.update(relative.as_bytes());
    hasher.update(bytes.to_le_bytes());
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "MIGRATION_PREFLIGHT_SMOKE_ARTIFACT_INVALID".to_owned())
}

fn percent_encode_segment(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~') {
            output.push(char::from(*byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            output.push('%');
            output.push(char::from(HEX[(byte >> 4) as usize]));
            output.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    output
}

fn canonical_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23) || matches!(byte, b'0'..=b'9' | b'a'..=b'f')
        })
}

fn lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::digest_tree;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQUENCE: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn product_digest_ignores_harness_profile_and_tracks_product_state() {
        let root = std::env::temp_dir().join(format!(
            "mythpen-preflight-digest-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("profile/cache")).unwrap();
        fs::write(root.join("profile/cache/browser.lock"), b"first").unwrap();
        let lifecycle_lock = root.join("control/sqlite/project.lifecycle.lock");
        fs::create_dir_all(lifecycle_lock.parent().unwrap()).unwrap();
        fs::write(&lifecycle_lock, b"").unwrap();
        let session_lease = root.join("locks/session.lease");
        fs::create_dir_all(session_lease.parent().unwrap()).unwrap();
        fs::write(&session_lease, b"").unwrap();
        let writer_lock = root.join("control/sqlite/project/.controlstore-writer.lock");
        fs::create_dir_all(writer_lock.parent().unwrap()).unwrap();
        fs::write(&writer_lock, b"").unwrap();

        #[cfg(windows)]
        let (held_lifecycle_lock, held_session_lease, held_writer_lock) = {
            use std::os::windows::fs::OpenOptionsExt;
            let lifecycle = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&lifecycle_lock)
                .unwrap();
            let session = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&session_lease)
                .unwrap();
            let writer = fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&writer_lock)
                .unwrap();
            (lifecycle, session, writer)
        };

        let before = digest_tree(&root).unwrap();
        fs::write(root.join("profile/cache/browser.lock"), b"second").unwrap();
        assert_eq!(digest_tree(&root).unwrap(), before);

        fs::create_dir_all(root.join("projects/example")).unwrap();
        assert_ne!(digest_tree(&root).unwrap(), before);

        #[cfg(windows)]
        drop(held_lifecycle_lock);
        #[cfg(windows)]
        drop(held_session_lease);
        #[cfg(windows)]
        drop(held_writer_lock);
        fs::remove_dir_all(root).unwrap();
    }
}
