// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! HTTP/1.1 over the daemon's Unix socket (a named pipe on Windows). One
//! connection per request: the socket is local, so pooling buys nothing and a
//! restarted daemon (new socket path in control.json) is picked up on the
//! very next call.

use std::path::PathBuf;
use std::time::Duration;

use http_body_util::{BodyExt, Full, LengthLimitError, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{CONTENT_TYPE, HOST};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use super::discovery::{self, DiscoveryError};
use super::envelope::decode_error_response;
use super::types::*;
use super::DaemonError;
use crate::native::agent_config::AgentId;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const INSTALLATION_NAME_MAX_CHARS: usize = 80;
const PATH_ID_MAX_LEN: usize = 128;
/// Proxied server JSON (boards, sessions) crosses a trust boundary; no
/// legitimate contract-A response comes near this.
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// The diagnostics zip is the one binary response: logs and state files
/// the daemon has already scrubbed, which can outgrow the JSON cap.
pub const DIAGNOSTICS_MAX_BYTES: usize = 64 * 1024 * 1024;
/// Building the zip walks the data dir; allow more than a JSON round trip.
const DIAGNOSTICS_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct DaemonClient {
    data_dir: Result<PathBuf, DiscoveryError>,
    request_timeout: Duration,
}

pub struct EventStream {
    body: Incoming,
}

impl EventStream {
    pub async fn next_chunk(&mut self) -> Option<Result<Bytes, DaemonError>> {
        loop {
            match self.body.frame().await? {
                Err(error) => return Some(Err(DaemonError::protocol(error.to_string()))),
                Ok(frame) => {
                    if let Ok(data) = frame.into_data() {
                        return Some(Ok(data));
                    }
                }
            }
        }
    }
}

/// Ids are spliced into a path, so anything beyond an opaque token is refused
/// rather than escaped: a crafted id must never reach another route.
fn opaque_id<'a>(id: &'a str, what: &str) -> Result<&'a str, DaemonError> {
    let opaque = !id.is_empty()
        && id.len() <= PATH_ID_MAX_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    if !opaque {
        return Err(DaemonError::invalid_input(format!("malformed {what} id")));
    }
    Ok(id)
}

pub(crate) fn pairing_path(pairing_id: &str) -> Result<String, DaemonError> {
    Ok(format!("/v1/pair/{}", opaque_id(pairing_id, "pairing")?))
}

pub(crate) fn mapping_path(mapping_id: &str) -> Result<String, DaemonError> {
    Ok(format!(
        "/v1/mappings/{}",
        opaque_id(mapping_id, "mapping")?
    ))
}

pub(crate) fn session_path(session_id: &str) -> Result<String, DaemonError> {
    Ok(format!(
        "/v1/sessions/{}",
        opaque_id(session_id, "session")?
    ))
}

/// The daemon resolves the path itself; the shell only refuses what can never
/// be a project root, and never touches the filesystem.
pub(crate) fn project_path_body(path: &str) -> Result<Value, DaemonError> {
    if path.contains('\0') || !std::path::Path::new(path).is_absolute() {
        return Err(DaemonError::invalid_input(
            "the project path must be absolute",
        ));
    }
    Ok(json!({ "path": path }))
}

pub(crate) fn sessions_path(query: &SessionsQuery) -> String {
    let mut params = url::form_urlencoded::Serializer::new(String::new());
    if let Some(status) = &query.status {
        params.append_pair("status", status);
    }
    if let Some(limit) = query.limit {
        params.append_pair("limit", &limit.to_string());
    }
    if let Some(cursor) = &query.cursor {
        params.append_pair("cursor", cursor);
    }
    let encoded = params.finish();
    if encoded.is_empty() {
        "/v1/sessions".into()
    } else {
        format!("/v1/sessions?{encoded}")
    }
}

pub(crate) fn validate_installation_name(name: &str) -> Result<(), DaemonError> {
    if name.trim().is_empty() || name.chars().count() > INSTALLATION_NAME_MAX_CHARS {
        return Err(DaemonError::invalid_input(
            "the name must be 1 to 80 characters",
        ));
    }
    Ok(())
}

/// Discovery vetted the path earlier; right before connecting it must still
/// be a socket this user owns, not a symlink swapped in since.
#[cfg(unix)]
fn revalidate_socket(socket: &std::path::Path) -> Result<(), DaemonError> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let metadata = match std::fs::symlink_metadata(socket) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(DaemonError::unreachable("socket_unavailable"))
        }
        Err(_) => return Err(DaemonError::unreachable("socket_unsafe")),
        Ok(metadata) => metadata,
    };
    // SAFETY: getuid has no preconditions and cannot fail.
    let current_user = unsafe { libc::getuid() };
    if !metadata.file_type().is_socket() || metadata.uid() != current_user {
        return Err(DaemonError::unreachable("socket_unsafe"));
    }
    Ok(())
}

#[cfg(unix)]
async fn connect_transport(
    socket: &std::path::Path,
) -> Result<tokio::net::UnixStream, DaemonError> {
    revalidate_socket(socket)?;
    tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|_| DaemonError::unreachable("socket_unavailable"))
}

#[cfg(any(windows, test))]
const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
#[cfg(any(windows, test))]
const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
/// The daemon may learn who is calling but can never act as this user
/// through the connection, whoever turns out to be serving the pipe.
#[cfg(any(windows, test))]
const PIPE_SECURITY_QOS: u32 = SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION;
#[cfg(windows)]
const _: () = assert!(
    PIPE_SECURITY_QOS
        == windows_sys::Win32::Storage::FileSystem::SECURITY_SQOS_PRESENT
            | windows_sys::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION
);

#[cfg(any(windows, test))]
const ERROR_ACCESS_DENIED: i32 = 5;
#[cfg(any(windows, test))]
const ERROR_PIPE_BUSY: i32 = 231;
/// Every pipe instance busy is momentary: the daemon opens a new instance
/// as soon as it accepts. Twenty 50 ms waits stay far inside the request timeout.
#[cfg(any(windows, test))]
const PIPE_BUSY_ATTEMPTS: u32 = 20;
#[cfg(windows)]
const PIPE_BUSY_DELAY: Duration = Duration::from_millis(50);

#[cfg(any(windows, test))]
fn pipe_open_retries(raw_os_error: Option<i32>, attempt: u32) -> bool {
    raw_os_error == Some(ERROR_PIPE_BUSY) && attempt < PIPE_BUSY_ATTEMPTS
}

#[cfg(any(windows, test))]
fn pipe_open_failure_reason(raw_os_error: Option<i32>) -> &'static str {
    match raw_os_error {
        // The daemon's DACL grants this user full access to its own pipe.
        Some(ERROR_ACCESS_DENIED) => "socket_unsafe",
        _ => "socket_unavailable",
    }
}

#[cfg(any(windows, test))]
fn pipe_server_is_own_user(pipe_owner_sid: Option<&str>, user_sid: &str) -> bool {
    !user_sid.is_empty() && pipe_owner_sid == Some(user_sid)
}

/// Discovery accepted only this user's pipe name, but anyone can create a
/// pipe under any name while the daemon is down; the pipe's owner tells.
#[cfg(windows)]
async fn connect_transport(
    pipe: &std::path::Path,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, DaemonError> {
    use std::os::windows::io::AsRawHandle;
    use tokio::net::windows::named_pipe::ClientOptions;

    let mut attempt = 0;
    let client = loop {
        match ClientOptions::new()
            .security_qos_flags(PIPE_SECURITY_QOS)
            .open(pipe)
        {
            Ok(client) => break client,
            Err(error) if pipe_open_retries(error.raw_os_error(), attempt) => {
                attempt += 1;
                tokio::time::sleep(PIPE_BUSY_DELAY).await;
            }
            Err(error) => {
                return Err(DaemonError::unreachable(pipe_open_failure_reason(
                    error.raw_os_error(),
                )))
            }
        }
    };
    let user_sid = super::windows_identity::current_user_sid()
        .map_err(|_| DaemonError::unreachable("user_unknown"))?;
    let owner_sid = super::windows_identity::pipe_owner_sid(client.as_raw_handle()).ok();
    if !pipe_server_is_own_user(owner_sid.as_deref(), &user_sid) {
        return Err(DaemonError::unreachable("socket_unsafe"));
    }
    Ok(client)
}

#[cfg(not(any(unix, windows)))]
async fn connect_transport(
    _socket: &std::path::Path,
) -> Result<tokio::io::DuplexStream, DaemonError> {
    Err(DaemonError::unreachable("transport_unsupported"))
}

fn decode_body<T: DeserializeOwned>(path: &str, body: &[u8]) -> Result<T, DaemonError> {
    serde_json::from_slice(body).map_err(|error| DaemonError::protocol(format!("{path}: {error}")))
}

impl DaemonClient {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir: Ok(data_dir),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    pub fn from_environment() -> Self {
        Self {
            data_dir: discovery::data_dir_from_environment(),
            request_timeout: REQUEST_TIMEOUT,
        }
    }

    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    pub async fn status(&self) -> Result<CompanionStatus, DaemonError> {
        self.call(Method::GET, "/v1/status", None).await
    }

    pub async fn pause(&self) -> Result<PauseState, DaemonError> {
        self.call(Method::POST, "/v1/pause", None).await
    }

    pub async fn resume(&self) -> Result<PauseState, DaemonError> {
        self.call(Method::POST, "/v1/resume", None).await
    }

    pub async fn projects(&self) -> Result<ProjectsOverview, DaemonError> {
        self.call(Method::GET, "/v1/projects", None).await
    }

    pub async fn agents(&self) -> Result<Vec<AgentEntry>, DaemonError> {
        self.call(Method::GET, "/v1/agents", None).await
    }

    pub async fn boards(&self) -> Result<BoardsOverview, DaemonError> {
        self.call(Method::GET, "/v1/boards", None).await
    }

    pub async fn sessions(&self, query: SessionsQuery) -> Result<SessionsPage, DaemonError> {
        self.call(Method::GET, &sessions_path(&query), None).await
    }

    pub async fn queue_flush(&self) -> Result<QueueFlush, DaemonError> {
        self.call(Method::POST, "/v1/queue/flush", None).await
    }

    pub async fn agent_install(&self, agent: AgentId) -> Result<AgentEntry, DaemonError> {
        let path = format!("/v1/agents/{}/install", agent.as_str());
        self.call(Method::POST, &path, None).await
    }

    pub async fn agent_uninstall(&self, agent: AgentId) -> Result<AgentEntry, DaemonError> {
        let path = format!("/v1/agents/{}/uninstall", agent.as_str());
        self.call(Method::POST, &path, None).await
    }

    pub async fn update_settings(&self, update: SettingsUpdate) -> Result<Settings, DaemonError> {
        let body = update.to_body();
        if body.as_object().is_some_and(|members| members.is_empty()) {
            return Err(DaemonError::invalid_input("nothing to update"));
        }
        self.call(Method::PATCH, "/v1/settings", Some(body)).await
    }

    pub async fn mapping_create(&self, request: MappingCreate) -> Result<Mapping, DaemonError> {
        let body = serde_json::to_value(request)
            .map_err(|error| DaemonError::protocol(error.to_string()))?;
        self.call(Method::POST, "/v1/mappings", Some(body)).await
    }

    pub async fn mapping_update(
        &self,
        mapping_id: &str,
        update: MappingUpdate,
    ) -> Result<Mapping, DaemonError> {
        let path = mapping_path(mapping_id)?;
        let body = serde_json::to_value(update)
            .map_err(|error| DaemonError::protocol(error.to_string()))?;
        self.call(Method::PATCH, &path, Some(body)).await
    }

    pub async fn mapping_delete(&self, mapping_id: &str) -> Result<DeletedMapping, DaemonError> {
        self.call(Method::DELETE, &mapping_path(mapping_id)?, None)
            .await
    }

    pub async fn agent_access(&self) -> Result<AgentAccess, DaemonError> {
        self.call(Method::GET, "/v1/agent-access", None).await
    }

    pub async fn agent_access_set(
        &self,
        mapping_id: &str,
        enabled: bool,
    ) -> Result<AgentAccess, DaemonError> {
        let path = format!("{}/agent-access", mapping_path(mapping_id)?);
        self.call(Method::PUT, &path, Some(json!({ "enabled": enabled })))
            .await
    }

    pub async fn project_ignore(&self, path: &str) -> Result<IgnoredProject, DaemonError> {
        let body = project_path_body(path)?;
        self.call(Method::POST, "/v1/projects/ignore", Some(body))
            .await
    }

    pub async fn project_unignore(&self, path: &str) -> Result<UnignoredProject, DaemonError> {
        let body = project_path_body(path)?;
        self.call(Method::DELETE, "/v1/projects/ignore", Some(body))
            .await
    }

    pub async fn project_discover(&self, path: &str) -> Result<DiscoveredProject, DaemonError> {
        #[derive(serde::Deserialize)]
        struct Discovered {
            discovered: DiscoveredProject,
        }
        let body = project_path_body(path)?;
        let answer: Discovered = self
            .call(Method::POST, "/v1/projects/discover", Some(body))
            .await?;
        Ok(answer.discovered)
    }

    pub async fn session_get(&self, session_id: &str) -> Result<SessionDetail, DaemonError> {
        self.call(Method::GET, &session_path(session_id)?, None)
            .await
    }

    pub async fn session_usage(&self, session_id: &str) -> Result<SessionUsage, DaemonError> {
        let path = format!("{}/usage", session_path(session_id)?);
        self.call(Method::GET, &path, None).await
    }

    pub async fn pair_start(
        &self,
        endpoint: String,
        name: Option<String>,
        replace: bool,
    ) -> Result<PairingTicket, DaemonError> {
        let mut body = json!({ "endpoint": endpoint });
        if let Some(name) = name {
            body["name"] = json!(name);
        }
        if replace {
            body["replace"] = json!(true);
        }
        self.call(Method::POST, "/v1/pair/start", Some(body)).await
    }

    pub async fn pair_poll(&self, pairing_id: &str) -> Result<PairingProgress, DaemonError> {
        #[derive(serde::Deserialize)]
        struct Connected {
            installation_id: String,
            #[serde(default)]
            old_server_revoked: Option<bool>,
        }
        let path = pairing_path(pairing_id)?;
        let (status, body) = self.exchange(Method::GET, &path, None).await?;
        match status {
            StatusCode::ACCEPTED => {
                // 202 carries the error envelope; only its code tells an
                // approved, still-connecting pairing from a waiting one.
                match decode_error_response(status.as_u16(), &body) {
                    DaemonError::Api { code, .. } if code == "pairing_persisting" => {
                        Ok(PairingProgress::Persisting)
                    }
                    _ => Ok(PairingProgress::Pending),
                }
            }
            status if status.is_success() => {
                let connected: Connected = decode_body(&path, &body)?;
                Ok(PairingProgress::Connected {
                    installation_id: connected.installation_id,
                    old_server_revoked: connected.old_server_revoked,
                })
            }
            status => Err(decode_error_response(status.as_u16(), &body)),
        }
    }

    /// `GET /v1/pair`: the pending pairing, or `None` on the daemon's 404.
    pub async fn pair_current(&self) -> Result<Option<PairingTicket>, DaemonError> {
        let (status, body) = self.exchange(Method::GET, "/v1/pair", None).await?;
        match status {
            StatusCode::NOT_FOUND => Ok(None),
            status if status.is_success() => decode_body("/v1/pair", &body).map(Some),
            status => Err(decode_error_response(status.as_u16(), &body)),
        }
    }

    pub async fn pair_cancel(&self, pairing_id: &str) -> Result<PairingCancelled, DaemonError> {
        self.call(Method::DELETE, &pairing_path(pairing_id)?, None)
            .await
    }

    pub async fn rename(&self, name: String) -> Result<InstallationName, DaemonError> {
        validate_installation_name(&name)?;
        self.call(Method::POST, "/v1/rename", Some(json!({ "name": name })))
            .await
    }

    pub async fn disconnect(&self) -> Result<DisconnectResult, DaemonError> {
        self.call(Method::POST, "/v1/disconnect", None).await
    }

    pub async fn version(&self) -> Result<VersionReport, DaemonError> {
        self.call(Method::GET, "/v1/version", None).await
    }

    pub async fn diagnostics(&self) -> Result<Bytes, DaemonError> {
        const PATH: &str = "/v1/diagnostics";
        tokio::time::timeout(DIAGNOSTICS_TIMEOUT.max(self.request_timeout), async {
            let response = self.send(Method::GET, PATH, None).await?;
            let status = response.status();
            let is_zip = response
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with("application/zip"));
            let body = self
                .collect_limited(response, DIAGNOSTICS_MAX_BYTES)
                .await?;
            if !status.is_success() {
                return Err(decode_error_response(status.as_u16(), &body));
            }
            if !is_zip || !body.starts_with(b"PK") {
                return Err(DaemonError::protocol(format!(
                    "{PATH} did not answer with a zip"
                )));
            }
            Ok(body)
        })
        .await
        .map_err(|_| DaemonError::Timeout)?
    }

    pub async fn open_event_stream(&self) -> Result<EventStream, DaemonError> {
        let response = tokio::time::timeout(
            self.request_timeout,
            self.send(Method::GET, "/v1/events", None),
        )
        .await
        .map_err(|_| DaemonError::Timeout)??;
        let status = response.status();
        if !status.is_success() {
            let body = self.collect(response).await?;
            return Err(decode_error_response(status.as_u16(), &body));
        }
        let is_event_stream = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        if !is_event_stream {
            return Err(DaemonError::protocol(
                "/v1/events did not answer with text/event-stream",
            ));
        }
        Ok(EventStream {
            body: response.into_body(),
        })
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<T, DaemonError> {
        let (status, response_body) = self.exchange(method, path, body).await?;
        if !status.is_success() {
            return Err(decode_error_response(status.as_u16(), &response_body));
        }
        decode_body(path, &response_body)
    }

    async fn exchange(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(StatusCode, Bytes), DaemonError> {
        tokio::time::timeout(self.request_timeout, async {
            let response = self.send(method, path, body).await?;
            let status = response.status();
            Ok((status, self.collect(response).await?))
        })
        .await
        .map_err(|_| DaemonError::Timeout)?
    }

    async fn collect(&self, response: Response<Incoming>) -> Result<Bytes, DaemonError> {
        self.collect_limited(response, MAX_RESPONSE_BYTES).await
    }

    async fn collect_limited(
        &self,
        response: Response<Incoming>,
        limit_bytes: usize,
    ) -> Result<Bytes, DaemonError> {
        Limited::new(response.into_body(), limit_bytes)
            .collect()
            .await
            .map(|collected| collected.to_bytes())
            .map_err(|error| {
                if error.downcast_ref::<LengthLimitError>().is_some() {
                    DaemonError::ResponseTooLarge {
                        limit_bytes: limit_bytes as u32,
                    }
                } else {
                    DaemonError::protocol(error.to_string())
                }
            })
    }

    fn socket_path(&self) -> Result<PathBuf, DaemonError> {
        let data_dir = self
            .data_dir
            .as_ref()
            .map_err(|error| DaemonError::unreachable(error.reason_code()))?;
        discovery::resolve_socket(data_dir)
            .map_err(|error| DaemonError::unreachable(error.reason_code()))
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Response<Incoming>, DaemonError> {
        let stream = connect_transport(&self.socket_path()?).await?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|_| DaemonError::unreachable("socket_unavailable"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });

        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(HOST, "companion.local");
        let payload = match body {
            Some(body) => {
                request = request.header(CONTENT_TYPE, "application/json");
                Bytes::from(body.to_string())
            }
            None => Bytes::new(),
        };
        let request = request
            .body(Full::new(payload))
            .map_err(|error| DaemonError::protocol(error.to_string()))?;
        sender
            .send_request(request)
            .await
            .map_err(|_| DaemonError::unreachable("socket_unavailable"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_path_accepts_opaque_ids() {
        assert_eq!(
            pairing_path("pr_Ab-9_x"),
            Ok("/v1/pair/pr_Ab-9_x".to_string())
        );
    }

    #[test]
    fn pairing_path_rejects_path_traversal_and_separators() {
        for id in ["", "../status", "a/b", "a?b", "a%2Fb", "a b"] {
            assert!(
                matches!(pairing_path(id), Err(DaemonError::InvalidInput { .. })),
                "id={id:?}"
            );
        }
    }

    #[test]
    fn sessions_path_encodes_only_present_parameters() {
        assert_eq!(sessions_path(&SessionsQuery::default()), "/v1/sessions");
        let query = SessionsQuery {
            status: Some("active".into()),
            limit: Some(20),
            cursor: Some("a&b=c".into()),
        };
        assert_eq!(
            sessions_path(&query),
            "/v1/sessions?status=active&limit=20&cursor=a%26b%3Dc"
        );
    }

    #[test]
    fn validate_installation_name_accepts_one_to_eighty_characters() {
        assert_eq!(validate_installation_name("Ada's MacBook"), Ok(()));
        assert_eq!(validate_installation_name(&"é".repeat(80)), Ok(()));
    }

    #[test]
    fn validate_installation_name_rejects_blank_and_overlong_names() {
        for name in ["".to_string(), "   ".to_string(), "x".repeat(81)] {
            assert!(matches!(
                validate_installation_name(&name),
                Err(DaemonError::InvalidInput { .. })
            ));
        }
    }

    #[tokio::test]
    async fn status_without_a_resolvable_data_dir_is_unreachable() {
        let client = DaemonClient {
            data_dir: Err(DiscoveryError::HomeUnknown),
            request_timeout: REQUEST_TIMEOUT,
        };
        assert_eq!(
            client.status().await,
            Err(DaemonError::unreachable("home_unknown"))
        );
    }
}

#[cfg(test)]
mod pipe_tests {
    use super::*;

    const OWN_SID: &str = "S-1-5-21-3623811015-3361044348-30300820-1013";
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_PIPE_BUSY: i32 = 231;

    #[test]
    fn pipe_security_qos_lets_the_daemon_identify_but_never_impersonate() {
        const SECURITY_SQOS_PRESENT: u32 = 0x0010_0000;
        const IMPERSONATION_LEVEL_BITS: u32 = 0x0003_0000;
        const SECURITY_IDENTIFICATION: u32 = 0x0001_0000;
        assert_ne!(PIPE_SECURITY_QOS & SECURITY_SQOS_PRESENT, 0);
        assert_eq!(
            PIPE_SECURITY_QOS & IMPERSONATION_LEVEL_BITS,
            SECURITY_IDENTIFICATION
        );
    }

    #[test]
    fn pipe_open_retries_while_every_instance_is_busy() {
        assert!(pipe_open_retries(Some(ERROR_PIPE_BUSY), 0));
        assert!(pipe_open_retries(Some(ERROR_PIPE_BUSY), 3));
    }

    #[test]
    fn pipe_open_gives_up_on_other_errors_and_after_the_last_attempt() {
        assert!(!pipe_open_retries(Some(ERROR_PIPE_BUSY), 1_000));
        for error in [Some(ERROR_FILE_NOT_FOUND), Some(ERROR_ACCESS_DENIED), None] {
            assert!(!pipe_open_retries(error, 0), "{error:?}");
        }
    }

    #[test]
    fn pipe_open_failure_reason_matches_the_unix_socket_codes() {
        assert_eq!(
            pipe_open_failure_reason(Some(ERROR_FILE_NOT_FOUND)),
            "socket_unavailable"
        );
        assert_eq!(
            pipe_open_failure_reason(Some(ERROR_PIPE_BUSY)),
            "socket_unavailable"
        );
        assert_eq!(pipe_open_failure_reason(None), "socket_unavailable");
        // Our own pipe's DACL grants us full access; a denial means the name
        // is held by someone else.
        assert_eq!(
            pipe_open_failure_reason(Some(ERROR_ACCESS_DENIED)),
            "socket_unsafe"
        );
    }

    #[test]
    fn pipe_server_is_own_user_when_this_user_owns_the_pipe() {
        assert!(pipe_server_is_own_user(Some(OWN_SID), OWN_SID));
    }

    #[test]
    fn pipe_server_squatted_by_another_user_is_refused() {
        for owner in [
            Some("S-1-5-21-3623811015-3361044348-30300820-1014"),
            Some("S-1-5-32-544"),
            Some("S-1-5-18"),
            Some(""),
            None,
        ] {
            assert!(!pipe_server_is_own_user(owner, OWN_SID), "{owner:?}");
        }
        assert!(!pipe_server_is_own_user(Some(""), ""));
    }
}

#[cfg(all(test, unix))]
mod socket_tests {
    use super::*;

    #[tokio::test]
    async fn connect_transport_refuses_a_socket_path_swapped_for_a_symlink() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.sock");
        let _listener = tokio::net::UnixListener::bind(&real).unwrap();
        let link = dir.path().join("control.sock");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            connect_transport(&link).await.err(),
            Some(DaemonError::unreachable("socket_unsafe"))
        );
    }

    #[tokio::test]
    async fn connect_transport_refuses_a_path_that_is_not_a_socket() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("control.sock");
        std::fs::write(&file, "").unwrap();
        assert_eq!(
            connect_transport(&file).await.err(),
            Some(DaemonError::unreachable("socket_unsafe"))
        );
    }

    #[tokio::test]
    async fn connect_transport_connects_to_a_real_socket() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("control.sock");
        let _listener = tokio::net::UnixListener::bind(&socket).unwrap();
        assert!(connect_transport(&socket).await.is_ok());
    }

    #[tokio::test]
    async fn connect_transport_reports_a_missing_socket_as_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            connect_transport(&dir.path().join("control.sock"))
                .await
                .err(),
            Some(DaemonError::unreachable("socket_unavailable"))
        );
    }
}
