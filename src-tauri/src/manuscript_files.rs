use serde::Deserialize;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const MAX_CONTROLLED_JSON_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SIDECAR_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const ABOUT_SOURCE_URL: &str = "https://github.com/niyongsheng/mythpen";

#[cfg(debug_assertions)]
pub mod debug_files_smoke {
    use super::{canonical_nonce, canonical_uuid_v4, is_reparse, lexical_absolute, link_count};
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::{Path, PathBuf};

    pub const DEBUG_FILES_SMOKE_MARKER: &str = "mythpen.desktop-l2-files-smoke-bootstrap.v1";
    #[used]
    pub static DEBUG_FILES_SMOKE_BINARY_MARKER: [u8; 44] =
        *b"mythpen.desktop-l2-files-smoke-bootstrap.v1\0";
    pub const DEBUG_FILES_SMOKE_CASE_IDS: [&str; 8] = [
        "open_chapter_body",
        "open_chapter_sidecar",
        "open_volume_index",
        "reveal_project",
        "unknown_uid_rejected",
        "wrong_route_rejected",
        "hard_link_rejected",
        "reparse_alias_rejected",
    ];

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    pub struct DebugFilesSmokeError(&'static str);

    impl DebugFilesSmokeError {
        fn new(code: &'static str) -> Self {
            Self(code)
        }

        pub fn code(self) -> &'static str {
            self.0
        }
    }

    #[derive(Debug)]
    pub struct DebugFilesSmokeRequest {
        run_id: String,
        result_path: PathBuf,
        sidecar_path: PathBuf,
        request_path: PathBuf,
        request_bytes: Vec<u8>,
        claim_path: PathBuf,
    }

    impl DebugFilesSmokeRequest {
        pub fn run_id(&self) -> &str {
            &self.run_id
        }

        pub fn result_path(&self) -> &Path {
            &self.result_path
        }

        pub fn sidecar_path(&self) -> &Path {
            &self.sidecar_path
        }

        pub fn request_path(&self) -> &Path {
            &self.request_path
        }

        pub fn request_bytes(&self) -> &[u8] {
            &self.request_bytes
        }

        pub fn claim_path(&self) -> &Path {
            &self.claim_path
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct DebugFilesSmokeRequestWire {
        version: u8,
        #[serde(rename = "type")]
        request_type: String,
        run_id: String,
        nonce_sha256: String,
        result_path: String,
        sidecar_path: String,
    }

    fn ordinary_file(path: &Path) -> Result<(), DebugFilesSmokeError> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        if !metadata.is_file()
            || is_reparse(&metadata)
            || link_count(path, &metadata)
                .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?
                != 1
        {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        Ok(())
    }

    #[cfg(windows)]
    fn owned_by_current_user(path: &Path) -> bool {
        use std::ffi::c_void;
        use std::os::windows::ffi::OsStrExt;

        type Handle = *mut c_void;
        const TOKEN_QUERY: u32 = 0x0008;
        const TOKEN_USER_CLASS: u32 = 1;
        const SE_FILE_OBJECT: u32 = 1;
        const OWNER_SECURITY_INFORMATION: u32 = 0x0000_0001;

        #[repr(C)]
        struct SidAndAttributes {
            sid: *mut c_void,
            attributes: u32,
        }

        #[repr(C)]
        struct TokenUser {
            user: SidAndAttributes,
        }

        #[link(name = "advapi32")]
        extern "system" {
            fn GetNamedSecurityInfoW(
                object_name: *mut u16,
                object_type: u32,
                security_info: u32,
                owner: *mut *mut c_void,
                group: *mut *mut c_void,
                dacl: *mut *mut c_void,
                sacl: *mut *mut c_void,
                security_descriptor: *mut *mut c_void,
            ) -> u32;
            fn OpenProcessToken(process: Handle, desired_access: u32, token: *mut Handle) -> i32;
            fn GetTokenInformation(
                token: Handle,
                information_class: u32,
                information: *mut c_void,
                information_length: u32,
                return_length: *mut u32,
            ) -> i32;
            fn EqualSid(first: *mut c_void, second: *mut c_void) -> i32;
        }

        #[link(name = "kernel32")]
        extern "system" {
            fn GetCurrentProcess() -> Handle;
            fn CloseHandle(object: Handle) -> i32;
            fn LocalFree(memory: *mut c_void) -> *mut c_void;
        }

        let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        encoded.push(0);
        let mut owner = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        let security_status = unsafe {
            GetNamedSecurityInfoW(
                encoded.as_mut_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if security_status != 0 || owner.is_null() || descriptor.is_null() {
            return false;
        }

        let mut token = std::ptr::null_mut();
        let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } != 0;
        if !opened || token.is_null() {
            let _ = unsafe { LocalFree(descriptor) };
            return false;
        }
        let mut needed = 0_u32;
        let _ = unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        if needed == 0 {
            let _ = unsafe { CloseHandle(token) };
            let _ = unsafe { LocalFree(descriptor) };
            return false;
        }
        let word_size = std::mem::size_of::<usize>();
        let mut buffer = vec![0_usize; (needed as usize).div_ceil(word_size)];
        let loaded = unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } != 0;
        let equal = if loaded {
            let token_user = unsafe { &*(buffer.as_ptr().cast::<TokenUser>()) };
            !token_user.user.sid.is_null() && unsafe { EqualSid(owner, token_user.user.sid) } != 0
        } else {
            false
        };
        let _ = unsafe { CloseHandle(token) };
        let _ = unsafe { LocalFree(descriptor) };
        equal
    }

    #[cfg(not(windows))]
    fn owned_by_current_user(_path: &Path) -> bool {
        true
    }

    fn ordinary_directory_chain(path: &Path) -> Result<(), DebugFilesSmokeError> {
        let mut current = PathBuf::new();
        for component in path.components() {
            current.push(component.as_os_str());
            if !matches!(component, std::path::Component::Normal(_)) {
                continue;
            }
            let metadata = fs::symlink_metadata(&current)
                .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
            if !metadata.is_dir() || is_reparse(&metadata) {
                return Err(DebugFilesSmokeError::new(
                    "MANUSCRIPT_SMOKE_REQUEST_INVALID",
                ));
            }
        }
        Ok(())
    }

    fn exact_absolute_path(value: &str) -> Result<PathBuf, DebugFilesSmokeError> {
        if value.is_empty() {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let normalized = lexical_absolute(path.clone())
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        if normalized != path {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        Ok(path)
    }

    pub fn load_authenticated_request(
        request_path: &Path,
        nonce: &str,
    ) -> Result<DebugFilesSmokeRequest, DebugFilesSmokeError> {
        load_authenticated_request_for_type(
            request_path,
            nonce,
            "mythpen.desktop-l2-files-smoke-request.v1",
        )
    }

    pub fn load_migration_preflight_request(
        request_path: &Path,
        nonce: &str,
    ) -> Result<DebugFilesSmokeRequest, DebugFilesSmokeError> {
        load_authenticated_request_for_type(
            request_path,
            nonce,
            "mythpen.desktop-l2-migration-preflight-smoke-request.v1",
        )
    }

    fn load_authenticated_request_for_type(
        request_path: &Path,
        nonce: &str,
        expected_request_type: &str,
    ) -> Result<DebugFilesSmokeRequest, DebugFilesSmokeError> {
        if !canonical_nonce(nonce) || !request_path.is_absolute() {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_UNAUTHENTICATED",
            ));
        }
        let request_path = lexical_absolute(request_path.to_path_buf())
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        ordinary_directory_chain(
            request_path
                .parent()
                .ok_or_else(|| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?,
        )?;
        ordinary_file(&request_path)?;
        if !owned_by_current_user(&request_path) {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let request_bytes = fs::read(&request_path)
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        if request_bytes.is_empty() || request_bytes.len() > 64 * 1024 {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let wire: DebugFilesSmokeRequestWire = serde_json::from_slice(&request_bytes)
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        if wire.version != 1
            || wire.request_type != expected_request_type
            || !canonical_uuid_v4(&wire.run_id)
        {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let expected_nonce_sha256 = hex::encode(Sha256::digest(nonce.as_bytes()));
        if wire.nonce_sha256 != expected_nonce_sha256 {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_UNAUTHENTICATED",
            ));
        }

        let result_path = exact_absolute_path(&wire.result_path)?;
        let sidecar_path = exact_absolute_path(&wire.sidecar_path)?;
        ordinary_directory_chain(
            sidecar_path
                .parent()
                .ok_or_else(|| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?,
        )?;
        ordinary_file(&sidecar_path)?;
        if result_path.exists() {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let request_parent = request_path
            .parent()
            .ok_or_else(|| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        if result_path.parent() != Some(request_parent) {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }
        let result_stem = result_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))?;
        let expected_request_name = format!(".{result_stem}.{}.request.json", wire.run_id);
        if request_path.file_name().and_then(|value| value.to_str())
            != Some(expected_request_name.as_str())
        {
            return Err(DebugFilesSmokeError::new(
                "MANUSCRIPT_SMOKE_REQUEST_INVALID",
            ));
        }

        let claim_path = PathBuf::from(format!("{}.claimed", request_path.display()));
        Ok(DebugFilesSmokeRequest {
            run_id: wire.run_id,
            result_path,
            sidecar_path,
            request_path,
            request_bytes,
            claim_path,
        })
    }

    pub fn claim_authenticated_request(
        request: &DebugFilesSmokeRequest,
    ) -> Result<(), DebugFilesSmokeError> {
        use std::io::Write;

        let mut claim = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(request.claim_path())
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_CONSUMED"))?;
        claim
            .write_all(request.run_id().as_bytes())
            .and_then(|_| claim.sync_all())
            .map_err(|_| DebugFilesSmokeError::new("MANUSCRIPT_SMOKE_REQUEST_INVALID"))
    }

    pub struct DebugSidecarJsonRequest<'a> {
        pub method: &'a str,
        pub target: &'a str,
        pub request_id: Option<&'a str>,
        pub project_instance_uid: Option<&'a str>,
        pub body: Option<&'a serde_json::Value>,
        pub expected_status: u16,
    }

    pub fn sidecar_json_request(
        port: u16,
        nonce: &str,
        request: DebugSidecarJsonRequest<'_>,
    ) -> Result<serde_json::Value, String> {
        let body = request
            .body
            .map(serde_json::to_vec)
            .transpose()
            .map_err(|_| "MANUSCRIPT_SMOKE_REQUEST_INVALID".to_owned())?
            .unwrap_or_default();
        let mut headers = Vec::new();
        if !body.is_empty() {
            headers.push(("Content-Type", "application/json"));
        }
        if let Some(value) = request.request_id {
            headers.push(("X-Mythpen-Request-Id", value));
        }
        if let Some(value) = request.project_instance_uid {
            headers.push(("X-Mythpen-Project-Instance", value));
        }
        super::sidecar_request_json(
            port,
            nonce,
            request.method,
            request.target,
            &headers,
            &body,
            request.expected_status,
        )
        .map_err(|error| error.code().to_owned())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManuscriptProjectRoute {
    Files,
    Sqlite,
    Migrating,
    Retired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManuscriptResourceKind {
    VolumeIndex,
    ChapterBody,
    ChapterSidecar,
}

impl ManuscriptResourceKind {
    pub fn from_wire(value: &str) -> Result<Self, ManuscriptHostError> {
        match value {
            "volume_index" => Ok(Self::VolumeIndex),
            "chapter_body" => Ok(Self::ChapterBody),
            "chapter_sidecar" => Ok(Self::ChapterSidecar),
            _ => Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_KIND_INVALID")),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManuscriptResourceRequest {
    project_uid: String,
    project_instance_uid: String,
    resource_kind: ManuscriptResourceKind,
    resource_uid: String,
}

impl ManuscriptResourceRequest {
    pub fn new(
        project_uid: &str,
        project_instance_uid: &str,
        resource_kind: ManuscriptResourceKind,
        resource_uid: &str,
    ) -> Result<Self, ManuscriptHostError> {
        if !canonical_uuid_v4(project_uid)
            || !canonical_uuid_v4(project_instance_uid)
            || !canonical_uuid_v4(resource_uid)
        {
            return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_INVALID"));
        }
        Ok(Self {
            project_uid: project_uid.to_owned(),
            project_instance_uid: project_instance_uid.to_owned(),
            resource_kind,
            resource_uid: resource_uid.to_owned(),
        })
    }

    pub fn project_uid(&self) -> &str {
        &self.project_uid
    }

    pub fn project_instance_uid(&self) -> &str {
        &self.project_instance_uid
    }
}

pub trait AuthenticatedManuscriptSession {
    fn canonical_data_root(&self) -> &Path;
    fn project_uid(&self) -> &str;
    fn project_instance_uid(&self) -> &str;
    fn route(&self) -> ManuscriptProjectRoute;
}

pub trait ManuscriptFileLauncher {
    fn open(&self, path: &Path) -> Result<(), String>;
    fn reveal(&self, path: &Path) -> Result<(), String>;
}

pub trait ExternalHttpsLauncher {
    fn open_external_https(&self, url: &str) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemManuscriptLauncher;

impl SystemManuscriptLauncher {
    #[cfg(not(windows))]
    fn spawn(program: &str, arguments: &[&std::ffi::OsStr]) -> Result<(), String> {
        let mut command = Command::new(program);
        command.args(arguments);
        command
            .spawn()
            .map(|_| ())
            .map_err(|_| "HOST_LAUNCH_FAILED".to_owned())
    }

    fn open_target(target: &std::ffi::OsStr) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::ffi::c_void;
            use std::os::windows::ffi::OsStrExt;

            #[link(name = "shell32")]
            extern "system" {
                fn ShellExecuteW(
                    window: *mut c_void,
                    operation: *const u16,
                    file: *const u16,
                    parameters: *const u16,
                    directory: *const u16,
                    show_command: i32,
                ) -> *mut c_void;
            }

            let operation = "open\0".encode_utf16().collect::<Vec<_>>();
            let mut encoded_target = target.encode_wide().collect::<Vec<_>>();
            encoded_target.push(0);
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    operation.as_ptr(),
                    encoded_target.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                )
            } as isize;
            return if result > 32 {
                Ok(())
            } else {
                Err("HOST_LAUNCH_FAILED".to_owned())
            };
        }
        #[cfg(target_os = "macos")]
        {
            return Self::spawn("open", &[target]);
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            return Self::spawn("xdg-open", &[target]);
        }
        #[allow(unreachable_code)]
        Err("HOST_LAUNCH_UNSUPPORTED".to_owned())
    }
}

impl ManuscriptFileLauncher for SystemManuscriptLauncher {
    fn open(&self, path: &Path) -> Result<(), String> {
        Self::open_target(path.as_os_str())
    }

    fn reveal(&self, path: &Path) -> Result<(), String> {
        Self::open_target(path.as_os_str())
    }
}

impl ExternalHttpsLauncher for SystemManuscriptLauncher {
    fn open_external_https(&self, url: &str) -> Result<(), String> {
        Self::open_target(std::ffi::OsStr::new(url))
    }
}

pub fn open_allowed_external_https(
    url: &str,
    launcher: &dyn ExternalHttpsLauncher,
) -> Result<(), ManuscriptHostError> {
    if url != ABOUT_SOURCE_URL {
        return Err(ManuscriptHostError::new("EXTERNAL_HTTPS_URL_DENIED"));
    }
    launcher
        .open_external_https(url)
        .map_err(|_| ManuscriptHostError::new("EXTERNAL_HTTPS_LAUNCH_FAILED"))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedManuscriptPath {
    path: PathBuf,
}

impl ResolvedManuscriptPath {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub struct ManuscriptHostError {
    code: &'static str,
}

impl ManuscriptHostError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Debug for ManuscriptHostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl fmt::Display for ManuscriptHostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ManuscriptHostError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManuscriptIndex {
    format_version: u8,
    project_uid: String,
    volume_uids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChapterMembershipIndex {
    format_version: u8,
    kind: String,
    chapter_uids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VolumeIndex {
    format_version: u8,
    volume_uid: String,
    #[serde(rename = "title")]
    _title: String,
    #[serde(rename = "summary")]
    _summary: String,
    chapter_uids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChapterSidecar {
    format_version: u8,
    chapter_uid: String,
    #[serde(rename = "title")]
    _title: String,
    #[serde(rename = "outline")]
    _outline: String,
    #[serde(rename = "status")]
    _status: String,
    #[serde(rename = "summary")]
    _summary: String,
    #[serde(rename = "cognitive_frame")]
    _cognitive_frame: String,
    #[serde(rename = "emotional_anchor")]
    _emotional_anchor: String,
    #[serde(rename = "world_texture")]
    _world_texture: String,
    #[serde(rename = "concrete_mystery")]
    _concrete_mystery: String,
    #[serde(rename = "interpersonal_tension")]
    _interpersonal_tension: String,
}

struct ProjectPaths {
    article_root: PathBuf,
    chapters_root: PathBuf,
    manuscript_path: PathBuf,
    mythpen_root: PathBuf,
    unassigned_path: PathBuf,
    volumes_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedSidecarProjectSession {
    data_root: PathBuf,
    project_uid: String,
    project_instance_uid: String,
    route: ManuscriptProjectRoute,
}

impl AuthenticatedManuscriptSession for VerifiedSidecarProjectSession {
    fn canonical_data_root(&self) -> &Path {
        &self.data_root
    }

    fn project_uid(&self) -> &str {
        &self.project_uid
    }

    fn project_instance_uid(&self) -> &str {
        &self.project_instance_uid
    }

    fn route(&self) -> ManuscriptProjectRoute {
        self.route
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarProjectListRow {
    name: String,
    manuscript_route: String,
}

#[derive(Deserialize)]
struct SidecarProjectStatus {
    route: String,
    project_uid: Option<String>,
    project_instance_id: Option<String>,
}

fn canonical_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
        || bytes[14] != b'4'
        || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| {
        matches!(index, 8 | 13 | 18 | 23) || matches!(byte, b'0'..=b'9' | b'a'..=b'f')
    })
}

fn canonical_nonce(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn lexical_absolute(value: PathBuf) -> Result<PathBuf, ManuscriptHostError> {
    let absolute = if value.is_absolute() {
        value
    } else {
        std::env::current_dir()
            .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"))?
            .join(value)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"));
                }
            }
        }
    }
    if !normalized.is_absolute() {
        return Err(ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"));
    }
    Ok(normalized)
}

#[cfg(windows)]
fn persisted_data_root() -> Option<PathBuf> {
    let output = Command::new("reg.exe")
        .args(["query", r"HKCU\Software\Mythpen", "/v", "DataDir"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .find(|line| line.contains("DataDir") && line.contains("REG_"))?;
    let marker = line.find("REG_")?;
    let remainder = &line[marker..];
    let value_start = remainder.find(char::is_whitespace)?;
    let value = remainder[value_start..].trim();
    if value.is_empty() {
        None
    } else {
        Some(PathBuf::from(value))
    }
}

#[cfg(not(windows))]
fn persisted_data_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".mythpen-paths.json");
    let bytes = fs::read(path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("DataDir")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn resolve_desktop_data_root() -> Result<PathBuf, ManuscriptHostError> {
    let candidate = std::env::var_os("MYTHPEN_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(persisted_data_root)
        .or_else(|| {
            #[cfg(windows)]
            let home = std::env::var_os("USERPROFILE");
            #[cfg(not(windows))]
            let home = std::env::var_os("HOME");
            home.map(|value| PathBuf::from(value).join(".mythpen"))
        })
        .ok_or_else(|| ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"))?;
    lexical_absolute(candidate)
}

fn percent_encode_path_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        if matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(*byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            encoded.push('%');
            encoded.push(char::from(HEX[(byte >> 4) as usize]));
            encoded.push(char::from(HEX[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

fn sidecar_request_json<T: for<'de> Deserialize<'de>>(
    port: u16,
    nonce: &str,
    method: &str,
    target: &str,
    extra_headers: &[(&str, &str)],
    request_body: &[u8],
    expected_status: u16,
) -> Result<T, ManuscriptHostError> {
    if port == 0
        || !canonical_nonce(nonce)
        || !matches!(method, "GET" | "POST")
        || !target.starts_with("/api/")
        || target.bytes().any(|byte| byte <= b' ' || byte == 0x7f)
        || extra_headers.iter().any(|(name, value)| {
            name.is_empty()
                || name
                    .bytes()
                    .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'-')
                || value.bytes().any(|byte| byte == b'\r' || byte == b'\n')
        })
    {
        return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_UNAUTHENTICATED"));
    }
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&address.into(), Duration::from_secs(3))
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    write!(
        stream,
        "{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Mythpen-Instance-Nonce: {nonce}\r\nAccept: application/json\r\n"
    )
    .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    for (name, value) in extra_headers {
        write!(stream, "{name}: {value}\r\n")
            .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    }
    write!(
        stream,
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        request_body.len()
    )
    .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    stream
        .write_all(request_body)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    stream
        .flush()
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;

    let mut response = Vec::new();
    stream
        .take(MAX_SIDECAR_RESPONSE_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_SESSION_UNAVAILABLE"))?;
    if response.len() as u64 > MAX_SIDECAR_RESPONSE_BYTES {
        return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"));
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"))?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"))?;
    let mut lines = headers.split("\r\n");
    let expected_prefix = format!("HTTP/1.1 {expected_status} ");
    let status_line = lines.next();
    if !status_line.is_some_and(|status| status.starts_with(&expected_prefix)) {
        #[cfg(debug_assertions)]
        {
            let error_code =
                serde_json::from_slice::<serde_json::Value>(&response[(header_end + 4)..])
                    .ok()
                    .and_then(|value| {
                        value
                            .pointer("/error/code")
                            .or_else(|| value.get("code"))
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| "UNKNOWN".to_owned());
            eprintln!(
                "[Manuscript Host] unexpected sidecar status={} code={error_code}",
                status_line.unwrap_or("MISSING")
            );
        }
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_HOST_SESSION_UNAVAILABLE",
        ));
    }
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"));
        };
        if name.eq_ignore_ascii_case("transfer-encoding") {
            return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"));
        }
        if name.eq_ignore_ascii_case("content-length") {
            if content_length.is_some() {
                return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"));
            }
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"))?,
            );
        }
    }
    let body = &response[(header_end + 4)..];
    if content_length != Some(body.len()) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"));
    }
    serde_json::from_slice(body)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_HOST_RESPONSE_INVALID"))
}

fn sidecar_get_json<T: for<'de> Deserialize<'de>>(
    port: u16,
    nonce: &str,
    target: &str,
) -> Result<T, ManuscriptHostError> {
    sidecar_request_json(port, nonce, "GET", target, &[], &[], 200)
}

fn route_from_wire(value: &str) -> Option<ManuscriptProjectRoute> {
    match value {
        "files" => Some(ManuscriptProjectRoute::Files),
        "sqlite" => Some(ManuscriptProjectRoute::Sqlite),
        "migrating" => Some(ManuscriptProjectRoute::Migrating),
        "retired" => Some(ManuscriptProjectRoute::Retired),
        _ => None,
    }
}

pub fn resolve_authenticated_sidecar_project_session(
    data_root: &Path,
    port: u16,
    nonce: &str,
    project_uid: &str,
    project_instance_uid: &str,
) -> Result<VerifiedSidecarProjectSession, ManuscriptHostError> {
    if !canonical_nonce(nonce) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_HOST_UNAUTHENTICATED"));
    }
    if !canonical_uuid_v4(project_uid) || !canonical_uuid_v4(project_instance_uid) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_INVALID"));
    }
    validate_data_root(data_root)?;
    let projects: Vec<SidecarProjectListRow> = sidecar_get_json(port, nonce, "/api/projects")?;
    for project in projects {
        if route_from_wire(&project.manuscript_route).is_none() {
            return Err(ManuscriptHostError::new(
                "MANUSCRIPT_PROJECT_ROUTE_MISMATCH",
            ));
        }
        let target = format!(
            "/api/projects/by-name/{}/files-beta/status",
            percent_encode_path_segment(&project.name)
        );
        let status: SidecarProjectStatus = sidecar_get_json(port, nonce, &target)?;
        if status.project_uid.as_deref() != Some(project_uid) {
            continue;
        }
        let route = route_from_wire(&status.route)
            .ok_or_else(|| ManuscriptHostError::new("MANUSCRIPT_PROJECT_ROUTE_MISMATCH"))?;
        let actual_instance = status
            .project_instance_id
            .ok_or_else(|| ManuscriptHostError::new("MANUSCRIPT_PROJECT_INSTANCE_STALE"))?;
        if !canonical_uuid_v4(&actual_instance) {
            return Err(ManuscriptHostError::new(
                "MANUSCRIPT_PROJECT_INSTANCE_STALE",
            ));
        }
        return Ok(VerifiedSidecarProjectSession {
            data_root: data_root.to_path_buf(),
            project_uid: project_uid.to_owned(),
            project_instance_uid: actual_instance,
            route,
        });
    }
    Err(ManuscriptHostError::new("MANUSCRIPT_PROJECT_UID_MISMATCH"))
}

fn project_paths(data_root: &Path, project_uid: &str) -> ProjectPaths {
    let article_root = data_root.join("manuscripts").join(project_uid);
    let mythpen_root = article_root.join("mythpen");
    ProjectPaths {
        article_root,
        chapters_root: mythpen_root.join("chapters"),
        manuscript_path: mythpen_root.join("manuscript.json"),
        unassigned_path: mythpen_root.join("unassigned.json"),
        volumes_root: mythpen_root.join("volumes"),
        mythpen_root,
    }
}

fn validate_session<'a>(
    session: Option<&'a dyn AuthenticatedManuscriptSession>,
    project_uid: &str,
    project_instance_uid: &str,
) -> Result<&'a dyn AuthenticatedManuscriptSession, ManuscriptHostError> {
    if !canonical_uuid_v4(project_uid) || !canonical_uuid_v4(project_instance_uid) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_INVALID"));
    }
    let session =
        session.ok_or_else(|| ManuscriptHostError::new("MANUSCRIPT_HOST_UNAUTHENTICATED"))?;
    if session.project_uid() != project_uid {
        return Err(ManuscriptHostError::new("MANUSCRIPT_PROJECT_UID_MISMATCH"));
    }
    if session.route() != ManuscriptProjectRoute::Files {
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_PROJECT_ROUTE_MISMATCH",
        ));
    }
    if session.project_instance_uid() != project_instance_uid {
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_PROJECT_INSTANCE_STALE",
        ));
    }
    validate_data_root(session.canonical_data_root())?;
    Ok(session)
}

fn validate_data_root(root: &Path) -> Result<(), ManuscriptHostError> {
    if !root.is_absolute()
        || root
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"));
    }
    let metadata = fs::symlink_metadata(root)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"))?;
    if !metadata.is_dir() || is_reparse(&metadata) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(unix)]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(not(any(windows, unix)))]
fn is_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn link_count(path: &Path, _metadata: &fs::Metadata) -> Result<u64, ManuscriptHostError> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStrExt;

    type Handle = *mut c_void;
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
    const INVALID_HANDLE_VALUE: Handle = -1_isize as Handle;

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn GetFileInformationByHandle(
            file: Handle,
            information: *mut ByHandleFileInformation,
        ) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    let mut encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
    encoded.push(0);
    let handle = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_RESOURCE_IDENTITY_UNKNOWN",
        ));
    }
    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    let succeeded = unsafe { GetFileInformationByHandle(handle, information.as_mut_ptr()) } != 0;
    let _ = unsafe { CloseHandle(handle) };
    if !succeeded {
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_RESOURCE_IDENTITY_UNKNOWN",
        ));
    }
    Ok(unsafe { information.assume_init() }.number_of_links as u64)
}

#[cfg(unix)]
fn link_count(_path: &Path, metadata: &fs::Metadata) -> Result<u64, ManuscriptHostError> {
    use std::os::unix::fs::MetadataExt;
    Ok(metadata.nlink())
}

#[cfg(not(any(windows, unix)))]
fn link_count(_path: &Path, _metadata: &fs::Metadata) -> Result<u64, ManuscriptHostError> {
    Ok(1)
}

fn inspect_path(
    data_root: &Path,
    target: &Path,
    expect_directory: bool,
) -> Result<fs::Metadata, ManuscriptHostError> {
    let relative = target
        .strip_prefix(data_root)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_RESOURCE_ROOT_ESCAPE"))?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_ROOT_ESCAPE"));
    }

    let mut current = data_root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current)
            .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_RESOURCE_NOT_FOUND"))?;
        if is_reparse(&metadata) {
            return Err(ManuscriptHostError::new(
                "MANUSCRIPT_RESOURCE_REPARSE_POINT",
            ));
        }
    }

    let metadata = fs::symlink_metadata(target)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_RESOURCE_NOT_FOUND"))?;
    if (expect_directory && !metadata.is_dir()) || (!expect_directory && !metadata.is_file()) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_WRONG_KIND"));
    }
    if !expect_directory && link_count(target, &metadata)? != 1 {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_HARD_LINK"));
    }

    let canonical_root = fs::canonicalize(data_root)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_DATA_ROOT_INVALID"))?;
    let canonical_target = fs::canonicalize(target)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_RESOURCE_NOT_FOUND"))?;
    if !canonical_target.starts_with(canonical_root) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_ROOT_ESCAPE"));
    }
    Ok(metadata)
}

fn read_json<T: for<'de> Deserialize<'de>>(
    data_root: &Path,
    path: &Path,
) -> Result<T, ManuscriptHostError> {
    let metadata = inspect_path(data_root, path, false)?;
    if metadata.len() == 0 || metadata.len() > MAX_CONTROLLED_JSON_BYTES {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
    }
    let bytes =
        fs::read(path).map_err(|_| ManuscriptHostError::new("MANUSCRIPT_RESOURCE_NOT_FOUND"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"))
}

fn validate_project_index(
    data_root: &Path,
    paths: &ProjectPaths,
    project_uid: &str,
) -> Result<ManuscriptIndex, ManuscriptHostError> {
    inspect_path(data_root, &paths.article_root, true)?;
    inspect_path(data_root, &paths.mythpen_root, true)?;
    inspect_path(data_root, &paths.volumes_root, true)?;
    inspect_path(data_root, &paths.chapters_root, true)?;
    let manuscript: ManuscriptIndex = read_json(data_root, &paths.manuscript_path)?;
    if manuscript.format_version != 1 {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
    }
    if manuscript.project_uid != project_uid {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_MISMATCH"));
    }
    if !valid_unique_uids(&manuscript.volume_uids) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
    }
    Ok(manuscript)
}

fn chapter_is_active(
    data_root: &Path,
    paths: &ProjectPaths,
    manuscript: &ManuscriptIndex,
    chapter_uid: &str,
) -> Result<bool, ManuscriptHostError> {
    let unassigned: ChapterMembershipIndex = read_json(data_root, &paths.unassigned_path)?;
    if unassigned.format_version != 1 || unassigned.kind != "unassigned" {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
    }
    if !valid_unique_uids(&unassigned.chapter_uids) {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
    }
    let mut memberships = usize::from(unassigned.chapter_uids.iter().any(|uid| uid == chapter_uid));
    for volume_uid in &manuscript.volume_uids {
        let volume_path = paths.volumes_root.join(format!("vol_{volume_uid}.json"));
        let volume: VolumeIndex = read_json(data_root, &volume_path)?;
        if volume.format_version != 1 || volume.volume_uid != *volume_uid {
            return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_MISMATCH"));
        }
        if !valid_unique_uids(&volume.chapter_uids) {
            return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
        }
        if volume.chapter_uids.iter().any(|uid| uid == chapter_uid) {
            memberships += 1;
        }
    }
    if memberships > 1 {
        return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_INVALID_JSON"));
    }
    Ok(memberships == 1)
}

fn valid_unique_uids(values: &[String]) -> bool {
    use std::collections::BTreeSet;

    values.iter().all(|uid| canonical_uuid_v4(uid))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

pub fn resolve_manuscript_resource(
    session: Option<&dyn AuthenticatedManuscriptSession>,
    request: &ManuscriptResourceRequest,
) -> Result<ResolvedManuscriptPath, ManuscriptHostError> {
    let session = validate_session(
        session,
        request.project_uid(),
        request.project_instance_uid(),
    )?;
    let data_root = session.canonical_data_root();
    let paths = project_paths(data_root, request.project_uid());
    let manuscript = validate_project_index(data_root, &paths, request.project_uid())?;

    let path = match request.resource_kind {
        ManuscriptResourceKind::VolumeIndex => {
            if !manuscript
                .volume_uids
                .iter()
                .any(|uid| uid == &request.resource_uid)
            {
                return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UNKNOWN_UID"));
            }
            let target = paths
                .volumes_root
                .join(format!("vol_{}.json", request.resource_uid));
            let volume: VolumeIndex = read_json(data_root, &target)?;
            if volume.format_version != 1 || volume.volume_uid != request.resource_uid {
                return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_MISMATCH"));
            }
            target
        }
        ManuscriptResourceKind::ChapterBody | ManuscriptResourceKind::ChapterSidecar => {
            if !chapter_is_active(data_root, &paths, &manuscript, &request.resource_uid)? {
                return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UNKNOWN_UID"));
            }
            let body = paths
                .chapters_root
                .join(format!("ch_{}.md", request.resource_uid));
            inspect_path(data_root, &body, false)?;
            let sidecar = paths
                .chapters_root
                .join(format!("ch_{}.json", request.resource_uid));
            let parsed: ChapterSidecar = read_json(data_root, &sidecar)?;
            if parsed.format_version != 1 || parsed.chapter_uid != request.resource_uid {
                return Err(ManuscriptHostError::new("MANUSCRIPT_RESOURCE_UID_MISMATCH"));
            }
            if request.resource_kind == ManuscriptResourceKind::ChapterBody {
                body
            } else {
                sidecar
            }
        }
    };
    Ok(ResolvedManuscriptPath { path })
}

pub fn resolve_manuscript_project_root(
    session: Option<&dyn AuthenticatedManuscriptSession>,
    project_uid: &str,
    project_instance_uid: &str,
) -> Result<ResolvedManuscriptPath, ManuscriptHostError> {
    let session = validate_session(session, project_uid, project_instance_uid)?;
    let paths = project_paths(session.canonical_data_root(), project_uid);
    validate_project_index(session.canonical_data_root(), &paths, project_uid)?;
    Ok(ResolvedManuscriptPath {
        path: paths.article_root,
    })
}

pub fn open_manuscript_resource(
    session: Option<&dyn AuthenticatedManuscriptSession>,
    request: &ManuscriptResourceRequest,
    launcher: &dyn ManuscriptFileLauncher,
) -> Result<(), ManuscriptHostError> {
    let resolved = resolve_manuscript_resource(session, request)?;
    launcher
        .open(resolved.path())
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_LAUNCH_FAILED"))
}

pub fn reveal_manuscript_project(
    session: Option<&dyn AuthenticatedManuscriptSession>,
    project_uid: &str,
    project_instance_uid: &str,
    launcher: &dyn ManuscriptFileLauncher,
) -> Result<(), ManuscriptHostError> {
    let resolved = resolve_manuscript_project_root(session, project_uid, project_instance_uid)?;
    launcher
        .reveal(resolved.path())
        .map_err(|_| ManuscriptHostError::new("MANUSCRIPT_LAUNCH_FAILED"))
}

pub fn resolve_authenticated_open_manuscript_resource(
    data_root: &Path,
    port: u16,
    nonce: &str,
    request: &ManuscriptResourceRequest,
) -> Result<ResolvedManuscriptPath, ManuscriptHostError> {
    let first = resolve_authenticated_sidecar_project_session(
        data_root,
        port,
        nonce,
        request.project_uid(),
        request.project_instance_uid(),
    )?;
    let first_path = resolve_manuscript_resource(Some(&first), request)?;
    let confirmed = resolve_authenticated_sidecar_project_session(
        data_root,
        port,
        nonce,
        request.project_uid(),
        request.project_instance_uid(),
    )?;
    let confirmed_path = resolve_manuscript_resource(Some(&confirmed), request)?;
    if first_path.path() != confirmed_path.path() {
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_PROJECT_INSTANCE_STALE",
        ));
    }
    Ok(confirmed_path)
}

pub fn resolve_authenticated_reveal_manuscript_project(
    data_root: &Path,
    port: u16,
    nonce: &str,
    project_uid: &str,
    project_instance_uid: &str,
) -> Result<ResolvedManuscriptPath, ManuscriptHostError> {
    let first = resolve_authenticated_sidecar_project_session(
        data_root,
        port,
        nonce,
        project_uid,
        project_instance_uid,
    )?;
    let first_path =
        resolve_manuscript_project_root(Some(&first), project_uid, project_instance_uid)?;
    let confirmed = resolve_authenticated_sidecar_project_session(
        data_root,
        port,
        nonce,
        project_uid,
        project_instance_uid,
    )?;
    let confirmed_path =
        resolve_manuscript_project_root(Some(&confirmed), project_uid, project_instance_uid)?;
    if first_path.path() != confirmed_path.path() {
        return Err(ManuscriptHostError::new(
            "MANUSCRIPT_PROJECT_INSTANCE_STALE",
        ));
    }
    Ok(confirmed_path)
}
