use serde::de::{Error as DeError, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub(crate) const CONTROL_CHANNEL: &str = "mythpen.sidecar.v1";
const MAX_CONTROL_LINE_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProtocolError {
    code: &'static str,
}

impl ProtocolError {
    fn invalid_frame() -> Self {
        Self {
            code: "SIDECAR_PROTOCOL_INVALID_FRAME",
        }
    }

    fn authentication_failed() -> Self {
        Self {
            code: "SIDECAR_PROTOCOL_AUTH_FAILED",
        }
    }

    pub(crate) fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl std::error::Error for ProtocolError {}

pub(crate) struct NonceSecret {
    encoded: String,
    digest: String,
}

impl NonceSecret {
    pub(crate) fn generate() -> Result<Self, ProtocolError> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| ProtocolError {
            code: "SIDECAR_NONCE_GENERATION_FAILED",
        })?;
        Ok(Self::from_bytes(bytes))
    }

    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        let encoded = hex::encode(bytes);
        let digest = hex::encode(Sha256::digest(bytes));
        Self { encoded, digest }
    }

    pub(crate) fn expose_for_renderer(&self) -> &str {
        &self.encoded
    }

    pub(crate) fn digest_hex(&self) -> &str {
        &self.digest
    }

    pub(crate) fn bootstrap_frame(&self) -> String {
        format!(
            "{{\"channel\":\"{CONTROL_CHANNEL}\",\"type\":\"bootstrap\",\"nonce\":\"{}\"}}\n",
            self.encoded
        )
    }

    pub(crate) fn build_info_request_frame(&self) -> String {
        format!(
            "{{\"channel\":\"{CONTROL_CHANNEL}\",\"type\":\"build.info.request\",\"nonce\":\"{}\"}}\n",
            self.encoded
        )
    }

    pub(crate) fn shutdown_request_frame(&self, attempt_seq: u64) -> String {
        self.shutdown_frame("shutdown.request", attempt_seq)
    }

    pub(crate) fn shutdown_continue_wait_frame(&self, attempt_seq: u64) -> String {
        self.shutdown_frame("shutdown.continue_wait", attempt_seq)
    }

    pub(crate) fn shutdown_cancel_frame(&self, attempt_seq: u64) -> String {
        self.shutdown_frame("shutdown.cancel", attempt_seq)
    }

    fn shutdown_frame(&self, frame_type: &str, attempt_seq: u64) -> String {
        format!(
            "{{\"channel\":\"{CONTROL_CHANNEL}\",\"type\":\"{frame_type}\",\"nonce\":\"{}\",\"attemptSeq\":{attempt_seq}}}\n",
            self.encoded
        )
    }
}

struct StrictObject(BTreeMap<String, Value>);

struct ControlChannelProbe(bool);

impl<'de> Deserialize<'de> for ControlChannelProbe {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ProbeVisitor;

        impl<'de> Visitor<'de> for ProbeVisitor {
            type Value = ControlChannelProbe;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut control_channel = false;
                while let Some(key) = access.next_key::<String>()? {
                    if key == "channel" {
                        let value = access.next_value::<Value>()?;
                        control_channel |= value.as_str() == Some(CONTROL_CHANNEL);
                    } else {
                        access.next_value::<IgnoredAny>()?;
                    }
                }
                Ok(ControlChannelProbe(control_channel))
            }
        }

        deserializer.deserialize_map(ProbeVisitor)
    }
}

impl<'de> Deserialize<'de> for StrictObject {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ObjectVisitor;

        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = StrictObject;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a JSON object with unique keys")
            }

            fn visit_map<M>(self, mut access: M) -> Result<Self::Value, M::Error>
            where
                M: MapAccess<'de>,
            {
                let mut values = BTreeMap::new();
                while let Some((key, value)) = access.next_entry::<String, Value>()? {
                    if values.insert(key, value).is_some() {
                        return Err(M::Error::custom("duplicate field"));
                    }
                }
                Ok(StrictObject(values))
            }
        }

        deserializer.deserialize_map(ObjectVisitor)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChildShutdownState {
    Quiescing,
    Draining,
    Closing,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChildControlFrame {
    Ready {
        child_pid: u32,
        host: String,
        port: u16,
        nonce_digest: String,
        native_activation_mode: String,
        source_commit: String,
        target_triple: String,
    },
    BuildInfo {
        child_pid: u32,
        nonce_digest: String,
        native_activation_mode: String,
        source_commit: String,
        target_triple: String,
    },
    ShutdownState {
        child_pid: u32,
        attempt_seq: u64,
        state: ChildShutdownState,
    },
    ShutdownSoftDeadline {
        child_pid: u32,
        attempt_seq: u64,
        state: ChildShutdownState,
    },
    ShutdownCancelled {
        child_pid: u32,
        attempt_seq: u64,
        service_epoch: u64,
    },
    ShutdownComplete {
        child_pid: u32,
        attempt_seq: u64,
    },
    ShutdownFailed {
        child_pid: u32,
        attempt_seq: u64,
        code: String,
    },
    ControlError {
        code: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StdoutLine {
    Log,
    Control(ChildControlFrame),
}

fn exact_keys(object: &BTreeMap<String, Value>, expected: &[&str]) -> bool {
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    actual == expected
}

fn required_string(object: &BTreeMap<String, Value>, key: &str) -> Result<String, ProtocolError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(ProtocolError::invalid_frame)
}

fn required_u64(object: &BTreeMap<String, Value>, key: &str) -> Result<u64, ProtocolError> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or_else(ProtocolError::invalid_frame)
}

fn required_pid(object: &BTreeMap<String, Value>) -> Result<u32, ProtocolError> {
    u32::try_from(required_u64(object, "childPid")?).map_err(|_| ProtocolError::invalid_frame())
}

fn valid_lower_hex(value: &str, lengths: &[usize]) -> bool {
    lengths.contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_target_triple(value: &str) -> bool {
    let segments = value.split('-').collect::<Vec<_>>();
    segments.len() >= 3
        && segments.iter().all(|segment| {
            !segment.is_empty()
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'.')
        })
}

fn parse_build_fields(
    object: &BTreeMap<String, Value>,
) -> Result<(u32, String, String, String, String), ProtocolError> {
    let child_pid = required_pid(object)?;
    let nonce_digest = required_string(object, "nonceDigest")?;
    let native_activation_mode = required_string(object, "nativeActivationMode")?;
    let source_commit = required_string(object, "sourceCommit")?;
    let target_triple = required_string(object, "targetTriple")?;
    if !valid_lower_hex(&nonce_digest, &[64])
        || native_activation_mode != "off"
        || !valid_lower_hex(&source_commit, &[40, 64])
        || !valid_target_triple(&target_triple)
    {
        return Err(ProtocolError::invalid_frame());
    }
    Ok((
        child_pid,
        nonce_digest,
        native_activation_mode,
        source_commit,
        target_triple,
    ))
}

fn parse_shutdown_state(value: &str) -> Result<ChildShutdownState, ProtocolError> {
    match value {
        "quiescing" => Ok(ChildShutdownState::Quiescing),
        "draining" => Ok(ChildShutdownState::Draining),
        "closing" => Ok(ChildShutdownState::Closing),
        _ => Err(ProtocolError::invalid_frame()),
    }
}

fn parse_control_object(
    object: BTreeMap<String, Value>,
) -> Result<ChildControlFrame, ProtocolError> {
    let frame_type = required_string(&object, "type")?;
    match frame_type.as_str() {
        "ready" => {
            if !exact_keys(
                &object,
                &[
                    "channel",
                    "type",
                    "childPid",
                    "host",
                    "port",
                    "nonceDigest",
                    "nativeActivationMode",
                    "sourceCommit",
                    "targetTriple",
                ],
            ) {
                return Err(ProtocolError::invalid_frame());
            }
            let (child_pid, nonce_digest, mode, commit, triple) = parse_build_fields(&object)?;
            let host = required_string(&object, "host")?;
            let port = u16::try_from(required_u64(&object, "port")?)
                .map_err(|_| ProtocolError::invalid_frame())?;
            if host != "127.0.0.1" {
                return Err(ProtocolError::authentication_failed());
            }
            Ok(ChildControlFrame::Ready {
                child_pid,
                host,
                port,
                nonce_digest,
                native_activation_mode: mode,
                source_commit: commit,
                target_triple: triple,
            })
        }
        "build.info" => {
            if !exact_keys(
                &object,
                &[
                    "channel",
                    "type",
                    "childPid",
                    "nonceDigest",
                    "nativeActivationMode",
                    "sourceCommit",
                    "targetTriple",
                ],
            ) {
                return Err(ProtocolError::invalid_frame());
            }
            let (child_pid, nonce_digest, mode, commit, triple) = parse_build_fields(&object)?;
            Ok(ChildControlFrame::BuildInfo {
                child_pid,
                nonce_digest,
                native_activation_mode: mode,
                source_commit: commit,
                target_triple: triple,
            })
        }
        "shutdown.state" | "shutdown.soft_deadline" => {
            if !exact_keys(
                &object,
                &["channel", "type", "childPid", "attemptSeq", "state"],
            ) {
                return Err(ProtocolError::invalid_frame());
            }
            let child_pid = required_pid(&object)?;
            let attempt_seq = required_u64(&object, "attemptSeq")?;
            let state = parse_shutdown_state(&required_string(&object, "state")?)?;
            if frame_type == "shutdown.state" {
                Ok(ChildControlFrame::ShutdownState {
                    child_pid,
                    attempt_seq,
                    state,
                })
            } else {
                Ok(ChildControlFrame::ShutdownSoftDeadline {
                    child_pid,
                    attempt_seq,
                    state,
                })
            }
        }
        "shutdown.cancelled" => {
            if !exact_keys(
                &object,
                &[
                    "channel",
                    "type",
                    "childPid",
                    "attemptSeq",
                    "outcome",
                    "serviceEpoch",
                ],
            ) || required_string(&object, "outcome")? != "cancelled"
            {
                return Err(ProtocolError::invalid_frame());
            }
            Ok(ChildControlFrame::ShutdownCancelled {
                child_pid: required_pid(&object)?,
                attempt_seq: required_u64(&object, "attemptSeq")?,
                service_epoch: required_u64(&object, "serviceEpoch")?,
            })
        }
        "shutdown.complete" => {
            if !exact_keys(
                &object,
                &["channel", "type", "childPid", "attemptSeq", "outcome"],
            ) || required_string(&object, "outcome")? != "clean"
            {
                return Err(ProtocolError::invalid_frame());
            }
            Ok(ChildControlFrame::ShutdownComplete {
                child_pid: required_pid(&object)?,
                attempt_seq: required_u64(&object, "attemptSeq")?,
            })
        }
        "shutdown.failed" => {
            if !exact_keys(
                &object,
                &[
                    "channel",
                    "type",
                    "childPid",
                    "attemptSeq",
                    "outcome",
                    "code",
                ],
            ) || required_string(&object, "outcome")? != "failed"
            {
                return Err(ProtocolError::invalid_frame());
            }
            let code = required_string(&object, "code")?;
            if code != "STORAGE_UNAVAILABLE" {
                return Err(ProtocolError::invalid_frame());
            }
            Ok(ChildControlFrame::ShutdownFailed {
                child_pid: required_pid(&object)?,
                attempt_seq: required_u64(&object, "attemptSeq")?,
                code,
            })
        }
        "control.error" => {
            if !exact_keys(&object, &["channel", "type", "code"]) {
                return Err(ProtocolError::invalid_frame());
            }
            let code = required_string(&object, "code")?;
            if !matches!(
                code.as_str(),
                "CONTROL_INVALID_FRAME"
                    | "CONTROL_BOOTSTRAP_REQUIRED"
                    | "CONTROL_ALREADY_BOOTSTRAPPED"
                    | "CONTROL_AUTH_FAILED"
                    | "CONTROL_ATTEMPT_INVALID"
                    | "CONTROL_INVALID_STATE"
                    | "CONTROL_CANCEL_TOO_LATE"
            ) {
                return Err(ProtocolError::invalid_frame());
            }
            Ok(ChildControlFrame::ControlError { code })
        }
        _ => Err(ProtocolError::invalid_frame()),
    }
}

pub(crate) fn classify_stdout_line(bytes: &[u8]) -> Result<StdoutLine, ProtocolError> {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return Ok(StdoutLine::Log);
    };
    let Ok(ControlChannelProbe(true)) = serde_json::from_str::<ControlChannelProbe>(text) else {
        return Ok(StdoutLine::Log);
    };
    if bytes.len() > MAX_CONTROL_LINE_BYTES {
        return Err(ProtocolError::invalid_frame());
    }
    let StrictObject(object) =
        serde_json::from_str::<StrictObject>(text).map_err(|_| ProtocolError::invalid_frame())?;
    Ok(StdoutLine::Control(parse_control_object(object)?))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarBuildInfo {
    pub(crate) native_activation_mode: String,
    pub(crate) source_commit: String,
    pub(crate) target_triple: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarSession {
    pub(crate) port: u16,
    pub(crate) nonce: String,
    pub(crate) child_pid: u32,
    pub(crate) build_info: SidecarBuildInfo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ReadyCandidate {
    port: u16,
    native_activation_mode: String,
    source_commit: String,
    target_triple: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HandshakeEffect {
    RequestBuildInfo,
    Published,
}

pub(crate) struct SidecarSessionHandshake {
    child_pid: u32,
    nonce: String,
    nonce_digest: String,
    ready: Option<ReadyCandidate>,
    session: Option<SidecarSession>,
    invalidated: bool,
}

impl SidecarSessionHandshake {
    pub(crate) fn new(child_pid: u32, nonce: &str, nonce_digest: &str) -> Self {
        Self {
            child_pid,
            nonce: nonce.to_owned(),
            nonce_digest: nonce_digest.to_owned(),
            ready: None,
            session: None,
            invalidated: false,
        }
    }

    pub(crate) fn accept(
        &mut self,
        frame: ChildControlFrame,
    ) -> Result<HandshakeEffect, ProtocolError> {
        if self.invalidated {
            return Err(ProtocolError::authentication_failed());
        }
        match frame {
            ChildControlFrame::Ready {
                child_pid,
                host,
                port,
                nonce_digest,
                native_activation_mode,
                source_commit,
                target_triple,
            } => {
                if self.ready.is_some()
                    || self.session.is_some()
                    || child_pid != self.child_pid
                    || host != "127.0.0.1"
                    || nonce_digest != self.nonce_digest
                {
                    return Err(ProtocolError::authentication_failed());
                }
                self.ready = Some(ReadyCandidate {
                    port,
                    native_activation_mode,
                    source_commit,
                    target_triple,
                });
                Ok(HandshakeEffect::RequestBuildInfo)
            }
            ChildControlFrame::BuildInfo {
                child_pid,
                nonce_digest,
                native_activation_mode,
                source_commit,
                target_triple,
            } => {
                let ready = self
                    .ready
                    .as_ref()
                    .ok_or_else(ProtocolError::authentication_failed)?;
                if self.session.is_some()
                    || child_pid != self.child_pid
                    || nonce_digest != self.nonce_digest
                    || native_activation_mode != ready.native_activation_mode
                    || source_commit != ready.source_commit
                    || target_triple != ready.target_triple
                {
                    return Err(ProtocolError::authentication_failed());
                }
                self.session = Some(SidecarSession {
                    port: ready.port,
                    nonce: self.nonce.clone(),
                    child_pid: self.child_pid,
                    build_info: SidecarBuildInfo {
                        native_activation_mode,
                        source_commit,
                        target_triple,
                    },
                });
                Ok(HandshakeEffect::Published)
            }
            _ => Err(ProtocolError::invalid_frame()),
        }
    }

    pub(crate) fn session(&self) -> Option<&SidecarSession> {
        self.session.as_ref()
    }

    pub(crate) fn invalidate(&mut self) {
        self.ready = None;
        self.session = None;
        self.invalidated = true;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_stdout_line, ChildControlFrame, HandshakeEffect, NonceSecret,
        SidecarSessionHandshake, StdoutLine,
    };

    const PID: u32 = 4242;
    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";
    const TRIPLE: &str = "x86_64-pc-windows-msvc";

    fn ready_line(digest: &str) -> String {
        format!(
            "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"ready\",\"childPid\":{PID},\"host\":\"127.0.0.1\",\"port\":54321,\"nonceDigest\":\"{digest}\",\"nativeActivationMode\":\"off\",\"sourceCommit\":\"{COMMIT}\",\"targetTriple\":\"{TRIPLE}\"}}"
        )
    }

    fn build_info_line(digest: &str) -> String {
        format!(
            "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"build.info\",\"childPid\":{PID},\"nonceDigest\":\"{digest}\",\"nativeActivationMode\":\"off\",\"sourceCommit\":\"{COMMIT}\",\"targetTriple\":\"{TRIPLE}\"}}"
        )
    }

    #[test]
    fn nonce_is_32_bytes_and_bootstrap_is_exact_ndjson() {
        let secret = NonceSecret::from_bytes([0xabu8; 32]);

        assert_eq!(secret.expose_for_renderer().len(), 64);
        assert!(secret
            .expose_for_renderer()
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase()));
        assert_eq!(
            secret.bootstrap_frame(),
            format!(
                "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"bootstrap\",\"nonce\":\"{}\"}}\n",
                secret.expose_for_renderer()
            )
        );
        assert_eq!(
            secret.digest_hex(),
            "9a2db2e23f1504cd056606553ac049c5e718e8f9ce9233876df1a7a1821af885"
        );
    }

    #[test]
    fn protocol_errors_never_format_the_raw_nonce() {
        let secret = NonceSecret::from_bytes([0xcdu8; 32]);
        let raw_nonce = secret.expose_for_renderer().to_owned();
        let malformed = format!(
            "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"ready\",\"nonce\":\"{raw_nonce}\"}}"
        );

        let error = classify_stdout_line(malformed.as_bytes()).unwrap_err();
        assert!(!format!("{error:?} {error}").contains(&raw_nonce));
    }

    #[test]
    fn strict_control_parser_rejects_unknown_and_duplicate_fields() {
        let secret = NonceSecret::from_bytes([1u8; 32]);
        let valid = ready_line(secret.digest_hex());
        let unknown = valid.replacen("}", ",\"extra\":true}", 1);
        let duplicate = valid.replacen("\"port\":54321", "\"port\":54321,\"port\":54322", 1);

        assert!(classify_stdout_line(unknown.as_bytes()).is_err());
        assert!(classify_stdout_line(duplicate.as_bytes()).is_err());
    }

    #[test]
    fn non_control_stdout_is_classified_as_log_without_echoing_content() {
        assert_eq!(
            classify_stdout_line(b"ordinary server log").unwrap(),
            StdoutLine::Log
        );
        assert_eq!(
            classify_stdout_line(br#"{\"level\":\"info\",\"message\":\"started\"}"#).unwrap(),
            StdoutLine::Log
        );
        assert_eq!(
            classify_stdout_line(b"ordinary log mentions mythpen.sidecar.v1").unwrap(),
            StdoutLine::Log
        );
        assert_eq!(
            classify_stdout_line(br#""mythpen.sidecar.v1""#).unwrap(),
            StdoutLine::Log
        );
        assert_eq!(
            classify_stdout_line(br#"{\"channel\":\"mythpen.sidecar.v1\""#).unwrap(),
            StdoutLine::Log
        );
        assert_eq!(
            classify_stdout_line(&vec![b'x'; super::MAX_CONTROL_LINE_BYTES + 1]).unwrap(),
            StdoutLine::Log
        );
    }

    #[test]
    fn oversized_control_object_is_rejected_after_channel_classification() {
        let padding = "x".repeat(super::MAX_CONTROL_LINE_BYTES);
        let line = format!(
            "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"ready\",\"padding\":\"{padding}\"}}"
        );
        assert!(classify_stdout_line(line.as_bytes()).is_err());
    }

    #[test]
    fn session_publishes_only_after_matching_ready_and_build_info() {
        let secret = NonceSecret::from_bytes([2u8; 32]);
        let mut handshake =
            SidecarSessionHandshake::new(PID, secret.expose_for_renderer(), secret.digest_hex());
        let ready = match classify_stdout_line(ready_line(secret.digest_hex()).as_bytes()).unwrap()
        {
            StdoutLine::Control(frame) => frame,
            StdoutLine::Log => panic!("ready must be a control frame"),
        };

        let first = handshake.accept(ready).unwrap();
        assert!(matches!(first, HandshakeEffect::RequestBuildInfo));
        assert!(handshake.session().is_none());

        let build =
            match classify_stdout_line(build_info_line(secret.digest_hex()).as_bytes()).unwrap() {
                StdoutLine::Control(frame) => frame,
                StdoutLine::Log => panic!("build info must be a control frame"),
            };
        assert!(matches!(
            handshake.accept(build).unwrap(),
            HandshakeEffect::Published
        ));
        let session = handshake
            .session()
            .expect("matching build info publishes session");
        assert_eq!(session.port, 54321);
        assert_eq!(session.child_pid, PID);
        assert_eq!(session.build_info.native_activation_mode, "off");
    }

    #[test]
    fn mismatched_or_out_of_order_build_info_never_publishes() {
        let secret = NonceSecret::from_bytes([3u8; 32]);
        let build =
            match classify_stdout_line(build_info_line(secret.digest_hex()).as_bytes()).unwrap() {
                StdoutLine::Control(frame) => frame,
                StdoutLine::Log => unreachable!(),
            };
        let mut out_of_order =
            SidecarSessionHandshake::new(PID, secret.expose_for_renderer(), secret.digest_hex());
        assert!(out_of_order.accept(build).is_err());
        assert!(out_of_order.session().is_none());

        let mut wrong_pid = SidecarSessionHandshake::new(
            PID + 1,
            secret.expose_for_renderer(),
            secret.digest_hex(),
        );
        let ready = match classify_stdout_line(ready_line(secret.digest_hex()).as_bytes()).unwrap()
        {
            StdoutLine::Control(frame) => frame,
            StdoutLine::Log => unreachable!(),
        };
        assert!(wrong_pid.accept(ready).is_err());
        assert!(wrong_pid.session().is_none());
    }

    #[test]
    fn owned_child_termination_invalidates_a_published_session_permanently() {
        let secret = NonceSecret::from_bytes([5u8; 32]);
        let mut handshake =
            SidecarSessionHandshake::new(PID, secret.expose_for_renderer(), secret.digest_hex());
        let ready = match classify_stdout_line(ready_line(secret.digest_hex()).as_bytes()).unwrap()
        {
            StdoutLine::Control(frame) => frame,
            StdoutLine::Log => unreachable!(),
        };
        handshake.accept(ready).unwrap();
        let build =
            match classify_stdout_line(build_info_line(secret.digest_hex()).as_bytes()).unwrap() {
                StdoutLine::Control(frame) => frame,
                StdoutLine::Log => unreachable!(),
            };
        handshake.accept(build).unwrap();
        assert!(handshake.session().is_some());

        handshake.invalidate();
        assert!(handshake.session().is_none());
        let replay = match classify_stdout_line(ready_line(secret.digest_hex()).as_bytes()).unwrap()
        {
            StdoutLine::Control(frame) => frame,
            StdoutLine::Log => unreachable!(),
        };
        assert!(handshake.accept(replay).is_err());
    }

    #[test]
    fn shutdown_frames_are_parsed_as_typed_control_events() {
        let line = format!(
            "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"shutdown.complete\",\"childPid\":{PID},\"attemptSeq\":1,\"outcome\":\"clean\"}}"
        );
        let frame = match classify_stdout_line(line.as_bytes()).unwrap() {
            StdoutLine::Control(frame) => frame,
            StdoutLine::Log => unreachable!(),
        };
        assert_eq!(
            frame,
            ChildControlFrame::ShutdownComplete {
                child_pid: PID,
                attempt_seq: 1,
            }
        );
    }

    #[test]
    fn authenticated_host_commands_have_exact_ndjson_shapes() {
        let secret = NonceSecret::from_bytes([4u8; 32]);
        let nonce = secret.expose_for_renderer();
        assert_eq!(
            secret.build_info_request_frame(),
            format!(
                "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"build.info.request\",\"nonce\":\"{nonce}\"}}\n"
            )
        );
        assert_eq!(
            secret.shutdown_request_frame(7),
            format!(
                "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"shutdown.request\",\"nonce\":\"{nonce}\",\"attemptSeq\":7}}\n"
            )
        );
        assert_eq!(
            secret.shutdown_continue_wait_frame(7),
            format!(
                "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"shutdown.continue_wait\",\"nonce\":\"{nonce}\",\"attemptSeq\":7}}\n"
            )
        );
        assert_eq!(
            secret.shutdown_cancel_frame(7),
            format!(
                "{{\"channel\":\"mythpen.sidecar.v1\",\"type\":\"shutdown.cancel\",\"nonce\":\"{nonce}\",\"attemptSeq\":7}}\n"
            )
        );
    }
}
