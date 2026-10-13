// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

#![cfg(unix)]
//! Drives the real client and event-stream supervisor against a fake contract-A
//! daemon: a tokio UnixListener speaking hand-written HTTP/1.1, so transport
//! chunking is under the test's control.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use backplane_companion_desktop_lib::daemon::client::MAX_RESPONSE_BYTES;
use backplane_companion_desktop_lib::daemon::stream::{run_event_stream, StreamConfig};
use backplane_companion_desktop_lib::daemon::types::{
    DaemonStreamMessage, MappingCreate, MappingUpdate, PairingProgress, QueueFlush, SessionsQuery,
    SettingsUpdate,
};
use backplane_companion_desktop_lib::daemon::{DaemonClient, DaemonError};
use backplane_companion_desktop_lib::native::agent_config::AgentId;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

const STATUS_JSON: &str = include_str!("fixtures/status.json");

#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    body: String,
}

struct FakeDaemon {
    data_dir: tempfile::TempDir,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    oversize_events: Arc<AtomicBool>,
    pending_pairing: Arc<AtomicBool>,
    server: Option<JoinHandle<()>>,
}

impl FakeDaemon {
    fn new() -> Self {
        // macOS caps sun_path at 104 bytes, so keep the socket under a short /tmp path.
        let data_dir = tempfile::Builder::new()
            .prefix("dk4")
            .tempdir_in("/tmp")
            .unwrap();
        Self {
            data_dir,
            requests: Arc::default(),
            oversize_events: Arc::default(),
            pending_pairing: Arc::default(),
            server: None,
        }
    }

    fn socket_path(&self) -> PathBuf {
        self.data_dir.path().join("control.sock")
    }

    fn client(&self) -> DaemonClient {
        DaemonClient::new(self.data_dir.path().to_path_buf())
            .with_request_timeout(Duration::from_secs(2))
    }

    fn start(&mut self) {
        let socket = self.socket_path();
        let _ = std::fs::remove_file(&socket);
        let listener = UnixListener::bind(&socket).unwrap();
        write_control_file(self.data_dir.path(), &socket);
        let requests = self.requests.clone();
        let oversize_events = self.oversize_events.clone();
        let pending_pairing = self.pending_pairing.clone();
        self.server = Some(tokio::spawn(async move {
            // Owned here so aborting the server also closes open connections,
            // as a real daemon exit would.
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                connections.spawn(serve(
                    stream,
                    requests.clone(),
                    oversize_events.clone(),
                    pending_pairing.clone(),
                ));
            }
        }));
    }

    /// Simulates a daemon exit: listener gone, control.json removed.
    fn stop(&mut self) {
        if let Some(server) = self.server.take() {
            server.abort();
        }
        let _ = std::fs::remove_file(self.data_dir.path().join("control.json"));
        let _ = std::fs::remove_file(self.socket_path());
    }

    fn recorded(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop();
    }
}

fn write_control_file(data_dir: &Path, socket: &Path) {
    let body = format!(
        r#"{{"version":1,"socket":"{}","pid":4242,"started_at":"2026-09-28T10:00:00Z"}}"#,
        socket.display()
    );
    std::fs::write(data_dir.join("control.json"), body).unwrap();
}

async fn read_request(stream: &mut UnixStream) -> Option<RecordedRequest> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    let head_end = loop {
        if let Some(position) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break position + 4;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_string();
    let path = request_line.next()?.to_string();
    let content_length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while buffer.len() < head_end + content_length {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let body = String::from_utf8_lossy(&buffer[head_end..]).to_string();
    Some(RecordedRequest { method, path, body })
}

async fn respond(stream: &mut UnixStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

fn envelope(code: &str, message: &str) -> String {
    format!(r#"{{"error":{{"code":"{code}","message":"{message}","detail":null}}}}"#)
}

const AGENT_ENTRY: &str = r#"{"id":"claude_code","presence":null,"integration":{"state":"installed","config_path":"~/.claude/settings.json","problems":[],"notes":[],"trust":null},"action":null,"telemetry":null}"#;
const MAPPING_JSON: &str = r#"{"id":"map-1","installation_id":"inst-1","workspace_id":"ws-1","board_id":"board-1","root_path":null,"repo_url_normalized":"github.com/acme/app","origin":"explicit","enabled":true,"content_level":"standard","created_at":"2026-09-28T09:00:00Z","updated_at":"2026-09-28T09:00:00Z"}"#;
const SETTINGS_JSON: &str = r#"{"paused":false,"auto_match_repos":true,"enabled_agents":["claude_code"],"exclude_globs":[],"retention_days":null}"#;

const AGENT_ACCESS_JSON: &str = r#"{"key":{"present":true,"key_prefix":"vlr_ab12","server_state":"active"},"prerequisites":{"uvx":true},"mappings":[{"mapping_id":"map-1","enabled":true,"agents":[{"agent_id":"claude_code","scope":"folder","state":"configured","problem":null}]}],"warnings":[]}"#;

const DISCOVERED_JSON: &str = r#"{"discovered":{"root":"/home/me/code/app","repo_url":"github.com/acme/app","first_seen":"2026-09-29T09:00:00Z","reason":"not_bound","candidates":[],"refused_repo_url":"ignored"}}"#;

/// The contract-A endpoints the popover writes through; the words "missing"
/// and "reject" in an id or body make the daemon answer with an envelope.
fn contract_a_write(request: &RecordedRequest) -> Option<(&'static str, String)> {
    let ok = |body: &str| Some(("200 OK", body.to_string()));
    let not_found = || Some(("404 Not Found", envelope("not_found", "No such thing")));
    let path = request.path.as_str();
    let rejected = request.body.contains("reject") || path.contains("missing");
    match (request.method.as_str(), path) {
        ("POST", "/v1/queue/flush") => ok(r#"{"scheduled":true}"#),
        ("GET", "/v1/agent-access") => ok(AGENT_ACCESS_JSON),
        ("PUT", path) if path.ends_with("/agent-access") && rejected => Some((
            "409 Conflict",
            envelope("mapping_root_unknown", "Folder unknown"),
        )),
        ("PUT", "/v1/mappings/map-1/agent-access") => ok(AGENT_ACCESS_JSON),
        ("POST", "/v1/agents/pi_cli/install" | "/v1/agents/pi_cli/uninstall") => Some((
            "409 Conflict",
            envelope("agent_config_changed", "The config changed"),
        )),
        ("POST", path) if path.starts_with("/v1/agents/") => ok(AGENT_ENTRY),
        ("PATCH", "/v1/settings") if rejected => Some((
            "502 Bad Gateway",
            envelope("server_rejected", "Backplane refused"),
        )),
        ("PATCH", "/v1/settings") => ok(SETTINGS_JSON),
        ("POST", "/v1/mappings") if rejected => not_found(),
        ("POST", "/v1/mappings") => ok(MAPPING_JSON),
        ("PATCH" | "DELETE", path) if path.starts_with("/v1/mappings/") && rejected => not_found(),
        ("PATCH", path) if path.starts_with("/v1/mappings/") => ok(MAPPING_JSON),
        ("DELETE", "/v1/mappings/map-1") => ok(r#"{"deleted":"map-1"}"#),
        ("POST" | "DELETE", "/v1/projects/ignore") if rejected => Some((
            "400 Bad Request",
            envelope("not_a_directory", "Not a folder"),
        )),
        ("POST", "/v1/projects/ignore") => ok(r#"{"ignored":"/home/me/code/app"}"#),
        ("POST", "/v1/projects/discover") if rejected => Some((
            "409 Conflict",
            envelope("ignored_path", "That folder is ignored"),
        )),
        ("POST", "/v1/projects/discover") => ok(DISCOVERED_JSON),
        ("DELETE", "/v1/projects/ignore") => ok(r#"{"unignored":"/home/me/code/app"}"#),
        ("GET", path) if path.starts_with("/v1/sessions/") && rejected => not_found(),
        ("GET", "/v1/sessions/sess-1") => ok(r#"{"id":"sess-1","native_session_id":"n-1"}"#),
        ("GET", "/v1/sessions/sess-1/usage") => ok(r#"{"items":[]}"#),
        _ => None,
    }
}

async fn serve(
    mut stream: UnixStream,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    oversize_events: Arc<AtomicBool>,
    pending_pairing: Arc<AtomicBool>,
) {
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    requests.lock().unwrap().push(request.clone());
    if let Some((status, body)) = contract_a_write(&request) {
        return respond(&mut stream, status, &body).await;
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/status") => respond(&mut stream, "200 OK", STATUS_JSON).await,
        ("POST", "/v1/pause") => respond(&mut stream, "200 OK", r#"{"paused":true}"#).await,
        ("POST", "/v1/resume") => respond(&mut stream, "200 OK", r#"{"paused":false}"#).await,
        ("GET", "/v1/boards") => {
            respond(
                &mut stream,
                "502 Bad Gateway",
                &envelope("server_unreachable", "Backplane is unreachable"),
            )
            .await
        }
        ("GET", "/v1/pair/waiting") => {
            respond(
                &mut stream,
                "202 Accepted",
                &envelope("pairing_pending", "Waiting for approval"),
            )
            .await
        }
        ("GET", "/v1/pair/approved") => {
            respond(
                &mut stream,
                "200 OK",
                r#"{"connected":true,"installation_id":"inst_1"}"#,
            )
            .await
        }
        ("GET", "/v1/pair/storing") => {
            respond(
                &mut stream,
                "202 Accepted",
                &envelope("pairing_persisting", "Approved; connecting."),
            )
            .await
        }
        ("GET", "/v1/pair/switched") => {
            respond(
                &mut stream,
                "200 OK",
                r#"{"connected":true,"installation_id":"inst_2","old_server_revoked":false}"#,
            )
            .await
        }
        ("POST", "/v1/pair/start") => {
            respond(
                &mut stream,
                "200 OK",
                r#"{"pairing_id":"p1","user_code":"BCDF-GHJK","verification_uri":"https://bp.example.dev/companion/pair","verification_uri_complete":"https://bp.example.dev/companion/pair#code=BCDF-GHJK","expires_at":"2026-10-08T10:10:00Z","interval":5}"#,
            )
            .await
        }
        ("GET", "/v1/pair/stale") => {
            respond(
                &mut stream,
                "410 Gone",
                &envelope("pairing_expired", "The code expired"),
            )
            .await
        }
        ("GET", "/v1/pair") if pending_pairing.load(Ordering::SeqCst) => {
            respond(
                &mut stream,
                "200 OK",
                r#"{"pairing_id":"p1","user_code":"BCDF-GHJK","verification_uri":"https://app.example.dev/companion/pair","verification_uri_complete":"https://app.example.dev/companion/pair#code=BCDF-GHJK","expires_at":"2026-09-28T10:10:00Z","interval":5,"endpoint":"https://app.example.dev"}"#,
            )
            .await
        }
        ("POST", "/v1/rename") => respond(&mut stream, "200 OK", &request.body).await,
        ("GET", "/v1/sessions?status=oversize") => {
            respond(
                &mut stream,
                "200 OK",
                &format!("\"{}\"", "x".repeat(9 * 1024 * 1024)),
            )
            .await
        }
        ("GET", path) if path.starts_with("/v1/sessions") => {
            respond(&mut stream, "200 OK", r#"{"items":[],"next_cursor":null}"#).await
        }
        ("GET", "/v1/version") => respond(&mut stream, "200 OK", "not json").await,
        ("GET", "/v1/events") if oversize_events.load(Ordering::SeqCst) => {
            stream_oversized_event(&mut stream).await
        }
        ("GET", "/v1/events") => stream_events(&mut stream).await,
        _ => {
            respond(
                &mut stream,
                "404 Not Found",
                &envelope("not_found", "No such route"),
            )
            .await
        }
    }
}

/// Splits the status event across writes (mid-field and between CR/LF) and
/// interleaves pings, then holds the stream open until the server is stopped.
/// A status event whose single data line is twice the parser's per-event cap,
/// written in chunks, then held open as a hostile daemon would.
async fn stream_oversized_event(stream: &mut UnixStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).await.is_err()
        || stream.write_all(b"event: status\ndata: ").await.is_err()
    {
        return;
    }
    let chunk = vec![b'x'; 64 * 1024];
    for _ in 0..32 {
        if stream.write_all(&chunk).await.is_err() {
            return;
        }
    }
    loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if stream.write_all(b"x").await.is_err() {
            return;
        }
    }
}

async fn stream_events(stream: &mut UnixStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).await.is_err() {
        return;
    }
    let compact_status = serde_json::from_str::<serde_json::Value>(STATUS_JSON)
        .unwrap()
        .to_string();
    let status_event = format!("event: status\r\ndata: {compact_status}\r\n\r\n");
    let (first, rest) = status_event.split_at(20);
    let pieces = [
        ": ping\n\n",
        first,
        rest,
        "event: policy.changed\ndata: {}\n",
        "\n",
        "event: attention\ndata: {\"items\":[]}\n\n",
    ];
    for piece in pieces {
        if stream.write_all(piece.as_bytes()).await.is_err() {
            return;
        }
        let _ = stream.flush().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if stream.write_all(b": ping\n\n").await.is_err() {
            return;
        }
    }
}

#[tokio::test]
async fn status_decodes_the_daemon_status_document() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let status = daemon.client().status().await.unwrap();
    assert!(status.connected);
    assert_eq!(status.capture.state, "active");
    assert_eq!(
        status
            .agents
            .iter()
            .map(|a| a.state.as_str())
            .collect::<Vec<_>>(),
        vec!["receiving", "idle"]
    );
    assert_eq!(status.queue.records, 4);
}

#[tokio::test]
async fn pause_and_resume_post_to_the_daemon() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    assert!(client.pause().await.unwrap().paused);
    assert!(!client.resume().await.unwrap().paused);
    let recorded: Vec<(String, String)> = daemon
        .recorded()
        .into_iter()
        .map(|r| (r.method, r.path))
        .collect();
    assert_eq!(
        recorded,
        vec![
            ("POST".into(), "/v1/pause".into()),
            ("POST".into(), "/v1/resume".into())
        ]
    );
}

fn assert_api_error<T: std::fmt::Debug>(result: Result<T, DaemonError>, status: u16, code: &str) {
    match result {
        Err(DaemonError::Api {
            status: actual_status,
            code: actual_code,
            ..
        }) => assert_eq!((actual_status, actual_code.as_str()), (status, code)),
        other => panic!("expected a {status} {code} envelope, got {other:?}"),
    }
}

fn assert_invalid_input<T: std::fmt::Debug>(result: Result<T, DaemonError>) {
    assert!(
        matches!(result, Err(DaemonError::InvalidInput { .. })),
        "expected an input refusal, got {result:?}"
    );
}

fn last_request(daemon: &FakeDaemon) -> (String, String, serde_json::Value) {
    let request = daemon
        .recorded()
        .pop()
        .expect("a request reached the daemon");
    let body = if request.body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&request.body).unwrap()
    };
    (request.method, request.path, body)
}

#[tokio::test]
async fn queue_flush_posts_to_the_daemon_and_decodes_scheduled() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let flush = daemon.client().queue_flush().await.unwrap();
    assert_eq!(
        flush,
        QueueFlush {
            scheduled: true,
            reason: None
        }
    );
    let (method, path, _) = last_request(&daemon);
    assert_eq!(
        (method.as_str(), path.as_str()),
        ("POST", "/v1/queue/flush")
    );
}

#[test]
fn queue_flush_decodes_a_no_op_with_its_reason() {
    let flush: QueueFlush =
        serde_json::from_str(r#"{"scheduled":false,"reason":"queue_empty"}"#).unwrap();
    assert_eq!(
        flush,
        QueueFlush {
            scheduled: false,
            reason: Some("queue_empty".into())
        }
    );
}

#[tokio::test]
async fn queue_flush_without_a_daemon_is_unreachable() {
    let daemon = FakeDaemon::new();
    assert!(matches!(
        daemon.client().queue_flush().await,
        Err(DaemonError::Unreachable { .. })
    ));
}

#[tokio::test]
async fn agent_install_and_uninstall_post_to_the_agent_route() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let installed = client.agent_install(AgentId::ClaudeCode).await.unwrap();
    assert_eq!(installed.id, "claude_code");
    assert_eq!(
        installed.integration.map(|integration| integration.state),
        Some("installed".to_string())
    );
    assert_eq!(
        last_request(&daemon).1,
        "/v1/agents/claude_code/install".to_string()
    );
    client.agent_uninstall(AgentId::CodexCli).await.unwrap();
    assert_eq!(
        last_request(&daemon).1,
        "/v1/agents/codex_cli/uninstall".to_string()
    );
}

#[tokio::test]
async fn agent_install_and_uninstall_map_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    assert_api_error(
        client.agent_install(AgentId::PiCli).await,
        409,
        "agent_config_changed",
    );
    assert_api_error(
        client.agent_uninstall(AgentId::PiCli).await,
        409,
        "agent_config_changed",
    );
}

#[test]
fn settings_update_keeps_absent_null_and_listed_agents_apart() {
    let parse = |json: &str| {
        serde_json::from_str::<SettingsUpdate>(json)
            .unwrap()
            .to_body()
    };
    assert_eq!(
        parse(r#"{"auto_match_repos":false}"#),
        serde_json::json!({"auto_match_repos": false})
    );
    assert_eq!(
        parse(r#"{"enabled_agents":null}"#),
        serde_json::json!({"enabled_agents": null})
    );
    assert_eq!(
        parse(r#"{"enabled_agents":["claude_code","pi_cli"],"exclude_globs":["*/vendor/*"]}"#),
        serde_json::json!({"enabled_agents": ["claude_code", "pi_cli"], "exclude_globs": ["*/vendor/*"]})
    );
    assert_eq!(
        parse(r#"{"enabled_agents":[]}"#),
        serde_json::json!({"enabled_agents": []})
    );
    assert!(serde_json::from_str::<SettingsUpdate>(r#"{"enabled_agents":["cursor"]}"#).is_err());
}

#[tokio::test]
async fn update_settings_patches_only_the_members_given() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let update = SettingsUpdate {
        enabled_agents: Some(Some(vec![AgentId::ClaudeCode])),
        ..SettingsUpdate::default()
    };
    let settings = daemon.client().update_settings(update).await.unwrap();
    assert_eq!(settings.enabled_agents, vec!["claude_code".to_string()]);
    assert!(settings.auto_match_repos);
    assert_eq!(
        last_request(&daemon),
        (
            "PATCH".into(),
            "/v1/settings".into(),
            serde_json::json!({"enabled_agents": ["claude_code"]})
        )
    );
}

#[tokio::test]
async fn update_settings_maps_the_error_envelope_and_refuses_an_empty_update() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let rejected = SettingsUpdate {
        exclude_globs: Some(vec!["reject".into()]),
        ..SettingsUpdate::default()
    };
    assert_api_error(
        client.update_settings(rejected).await,
        502,
        "server_rejected",
    );
    let before = daemon.recorded().len();
    assert_invalid_input(client.update_settings(SettingsUpdate::default()).await);
    assert_eq!(daemon.recorded().len(), before);
}

fn mapping_request(board_id: &str) -> MappingCreate {
    MappingCreate {
        workspace_id: "ws-1".into(),
        board_id: board_id.into(),
        root_path: None,
        repo_url: Some("github.com/acme/app".into()),
        content_level: "standard".into(),
        enabled: None,
    }
}

#[tokio::test]
async fn mapping_create_posts_only_the_given_members() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let mapping = daemon
        .client()
        .mapping_create(mapping_request("board-1"))
        .await
        .unwrap();
    assert_eq!(
        (mapping.id.as_str(), mapping.board_id.as_deref()),
        ("map-1", Some("board-1"))
    );
    assert_eq!(
        last_request(&daemon),
        (
            "POST".into(),
            "/v1/mappings".into(),
            serde_json::json!({"workspace_id": "ws-1", "board_id": "board-1", "repo_url": "github.com/acme/app", "content_level": "standard"})
        )
    );
}

#[tokio::test]
async fn mapping_create_maps_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert_api_error(
        daemon
            .client()
            .mapping_create(mapping_request("reject"))
            .await,
        404,
        "not_found",
    );
}

#[tokio::test]
async fn mapping_update_and_delete_address_the_mapping() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let update = MappingUpdate {
        content_level: None,
        enabled: Some(false),
    };
    client.mapping_update("map-1", update).await.unwrap();
    assert_eq!(
        last_request(&daemon),
        (
            "PATCH".into(),
            "/v1/mappings/map-1".into(),
            serde_json::json!({"enabled": false})
        )
    );
    let deleted = client.mapping_delete("map-1").await.unwrap();
    assert_eq!(deleted.deleted, "map-1");
    let (method, path, _) = last_request(&daemon);
    assert_eq!(
        (method.as_str(), path.as_str()),
        ("DELETE", "/v1/mappings/map-1")
    );
}

#[tokio::test]
async fn mapping_update_and_delete_map_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let update = MappingUpdate {
        content_level: Some("full".into()),
        enabled: None,
    };
    assert_api_error(
        client.mapping_update("missing", update).await,
        404,
        "not_found",
    );
    assert_api_error(client.mapping_delete("missing").await, 404, "not_found");
}

#[tokio::test]
async fn mapping_and_session_ids_that_could_reach_another_route_are_refused() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let update = || MappingUpdate {
        content_level: None,
        enabled: Some(true),
    };
    for id in ["", "../settings", "a/b", "a?b", "a%2Fb"] {
        assert_invalid_input(client.mapping_update(id, update()).await);
        assert_invalid_input(client.mapping_delete(id).await);
        assert_invalid_input(client.session_get(id).await);
        assert_invalid_input(client.session_usage(id).await);
    }
    assert!(daemon.recorded().is_empty());
}

#[tokio::test]
async fn agent_access_get_decodes_the_daemon_document() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let access = daemon.client().agent_access().await.unwrap();
    assert!(access.key.present);
    assert_eq!(access.mappings[0].agents[0].agent_id, "claude_code");
    let (method, path, _) = last_request(&daemon);
    assert_eq!(
        (method.as_str(), path.as_str()),
        ("GET", "/v1/agent-access")
    );
}

#[tokio::test]
async fn agent_access_set_puts_only_enabled_to_the_mapping() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let access = daemon
        .client()
        .agent_access_set("map-1", false)
        .await
        .unwrap();
    assert_eq!(access.mappings[0].mapping_id, "map-1");
    assert_eq!(
        last_request(&daemon),
        (
            "PUT".into(),
            "/v1/mappings/map-1/agent-access".into(),
            serde_json::json!({"enabled": false})
        )
    );
}

#[tokio::test]
async fn agent_access_set_maps_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert_api_error(
        daemon.client().agent_access_set("missing", true).await,
        409,
        "mapping_root_unknown",
    );
}

#[tokio::test]
async fn agent_access_set_refuses_ids_that_could_reach_another_route() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    for id in ["", "../settings", "a/b", "a?b", "a%2Fb"] {
        assert_invalid_input(client.agent_access_set(id, true).await);
    }
    assert!(daemon.recorded().is_empty());
}

#[tokio::test]
async fn agent_access_get_without_a_daemon_is_unreachable() {
    let daemon = FakeDaemon::new();
    assert!(matches!(
        daemon.client().agent_access().await,
        Err(DaemonError::Unreachable { .. })
    ));
}

#[tokio::test]
async fn project_ignore_and_unignore_send_the_absolute_path() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let ignored = client.project_ignore("/home/me/code/app").await.unwrap();
    assert_eq!(ignored.ignored, "/home/me/code/app");
    assert_eq!(
        last_request(&daemon),
        (
            "POST".into(),
            "/v1/projects/ignore".into(),
            serde_json::json!({"path": "/home/me/code/app"})
        )
    );
    let unignored = client.project_unignore("/home/me/code/app").await.unwrap();
    assert_eq!(unignored.unignored, "/home/me/code/app");
    assert_eq!(
        last_request(&daemon),
        (
            "DELETE".into(),
            "/v1/projects/ignore".into(),
            serde_json::json!({"path": "/home/me/code/app"})
        )
    );
}

#[tokio::test]
async fn project_ignore_and_unignore_map_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    assert_api_error(
        client.project_ignore("/home/me/reject").await,
        400,
        "not_a_directory",
    );
    assert_api_error(
        client.project_unignore("/home/me/reject").await,
        400,
        "not_a_directory",
    );
}

#[tokio::test]
async fn project_paths_that_are_not_absolute_never_reach_the_daemon() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    for path in ["", "code/app", "./app", "~/code/app", "/home/me/\0app"] {
        assert_invalid_input(client.project_ignore(path).await);
        assert_invalid_input(client.project_unignore(path).await);
    }
    assert!(daemon.recorded().is_empty());
}

#[tokio::test]
async fn project_discover_posts_the_path_and_decodes_the_found_project() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let discovered = client
        .project_discover("/home/me/code/app/web")
        .await
        .unwrap();
    assert_eq!(discovered.root, "/home/me/code/app");
    assert_eq!(discovered.repo_url.as_deref(), Some("github.com/acme/app"));
    assert_eq!(discovered.reason.as_deref(), Some("not_bound"));
    assert_eq!(
        last_request(&daemon),
        (
            "POST".into(),
            "/v1/projects/discover".into(),
            serde_json::json!({"path": "/home/me/code/app/web"})
        )
    );
}

#[tokio::test]
async fn project_discover_maps_the_refusal_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert_api_error(
        daemon.client().project_discover("/home/me/reject").await,
        409,
        "ignored_path",
    );
}

#[tokio::test]
async fn project_discover_never_sends_a_relative_path() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    for path in ["", "code/app", "~/code/app", "/home/me/\0app"] {
        assert_invalid_input(client.project_discover(path).await);
    }
    assert!(daemon.recorded().is_empty());
}

#[tokio::test]
async fn session_get_and_usage_proxy_the_server_documents() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    let detail = client.session_get("sess-1").await.unwrap();
    assert_eq!(detail.0["native_session_id"], "n-1");
    assert_eq!(last_request(&daemon).1, "/v1/sessions/sess-1".to_string());
    let usage = client.session_usage("sess-1").await.unwrap();
    assert_eq!(usage.0, serde_json::json!({"items": []}));
    assert_eq!(
        last_request(&daemon).1,
        "/v1/sessions/sess-1/usage".to_string()
    );
}

#[tokio::test]
async fn session_get_and_usage_map_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    assert_api_error(client.session_get("missing").await, 404, "not_found");
    assert_api_error(client.session_usage("missing").await, 404, "not_found");
}

#[tokio::test]
async fn boards_maps_the_error_envelope() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let error = daemon.client().boards().await.unwrap_err();
    assert_eq!(
        error,
        DaemonError::Api {
            status: 502,
            code: "server_unreachable".into(),
            message: "Backplane is unreachable".into(),
            detail: None
        }
    );
}

#[tokio::test]
async fn pair_poll_reports_pending_on_202_and_connected_on_200() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    assert_eq!(
        client.pair_poll("waiting").await,
        Ok(PairingProgress::Pending)
    );
    assert_eq!(
        client.pair_poll("approved").await,
        Ok(PairingProgress::Connected {
            installation_id: "inst_1".into(),
            old_server_revoked: None,
        })
    );
}

#[tokio::test]
async fn pair_poll_reports_an_approved_pairing_that_is_still_connecting() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert_eq!(
        daemon.client().pair_poll("storing").await,
        Ok(PairingProgress::Persisting)
    );
}

#[tokio::test]
async fn pair_poll_reports_whether_a_switch_revoked_the_old_server() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert_eq!(
        daemon.client().pair_poll("switched").await,
        Ok(PairingProgress::Connected {
            installation_id: "inst_2".into(),
            old_server_revoked: Some(false),
        })
    );
}

#[tokio::test]
async fn pair_start_asks_to_replace_only_when_switching() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let client = daemon.client();
    client
        .pair_start("https://bp.example.dev".into(), None, false)
        .await
        .unwrap();
    client
        .pair_start(
            "https://other.example.dev".into(),
            Some("Studio Mac".into()),
            true,
        )
        .await
        .unwrap();
    let bodies: Vec<serde_json::Value> = daemon
        .recorded()
        .iter()
        .map(|request| serde_json::from_str(&request.body).unwrap())
        .collect();
    assert_eq!(
        bodies,
        vec![
            serde_json::json!({"endpoint":"https://bp.example.dev"}),
            serde_json::json!({"endpoint":"https://other.example.dev","name":"Studio Mac","replace":true}),
        ]
    );
}

#[tokio::test]
async fn pair_poll_surfaces_terminal_pairing_codes() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let error = daemon.client().pair_poll("stale").await.unwrap_err();
    assert!(
        matches!(error, DaemonError::Api { status: 410, ref code, .. } if code == "pairing_expired")
    );
}

#[tokio::test]
async fn pair_poll_rejects_a_hostile_id_without_calling_the_daemon() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert!(matches!(
        daemon.client().pair_poll("../status").await,
        Err(DaemonError::InvalidInput { .. })
    ));
    assert!(daemon.recorded().is_empty());
}

#[tokio::test]
async fn rename_sends_the_name_as_json() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let renamed = daemon.client().rename("Studio Mac".into()).await.unwrap();
    assert_eq!(renamed.name, "Studio Mac");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&daemon.recorded()[0].body).unwrap(),
        serde_json::json!({"name":"Studio Mac"})
    );
}

#[tokio::test]
async fn sessions_forwards_the_query_string() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let query = SessionsQuery {
        status: Some("active".into()),
        limit: Some(5),
        cursor: None,
    };
    daemon.client().sessions(query).await.unwrap();
    assert_eq!(
        daemon.recorded()[0].path,
        "/v1/sessions?status=active&limit=5"
    );
}

#[tokio::test]
async fn version_with_a_non_json_body_is_a_protocol_error() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert!(matches!(
        daemon.client().version().await,
        Err(DaemonError::Protocol { .. })
    ));
}

#[tokio::test]
async fn status_without_control_file_is_unreachable() {
    let daemon = FakeDaemon::new();
    assert_eq!(
        daemon.client().status().await,
        Err(DaemonError::unreachable("control_file_missing"))
    );
}

#[tokio::test]
async fn status_with_a_stale_control_file_is_unreachable() {
    let daemon = FakeDaemon::new();
    write_control_file(daemon.data_dir.path(), &daemon.socket_path());
    assert_eq!(
        daemon.client().status().await,
        Err(DaemonError::unreachable("socket_unavailable"))
    );
}

async fn next_message(
    receiver: &mut mpsc::UnboundedReceiver<DaemonStreamMessage>,
) -> DaemonStreamMessage {
    tokio::time::timeout(Duration::from_secs(5), receiver.recv())
        .await
        .expect("stream message in time")
        .unwrap()
}

fn test_stream_config() -> StreamConfig {
    StreamConfig {
        initial_backoff: Duration::from_millis(10),
        max_backoff: Duration::from_millis(40),
        idle_timeout: Duration::from_secs(2),
    }
}

#[tokio::test]
async fn event_stream_reports_unreachable_then_forwards_events_once_the_daemon_starts() {
    let mut daemon = FakeDaemon::new();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let supervisor = tokio::spawn(run_event_stream(
        daemon.client(),
        test_stream_config(),
        move |message| {
            let _ = sender.send(message);
        },
    ));

    assert_eq!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Unreachable {
            reason: "control_file_missing".into()
        }
    );

    daemon.start();
    assert_eq!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Connected
    );
    let DaemonStreamMessage::Status(status) = next_message(&mut receiver).await else {
        panic!("expected status")
    };
    assert_eq!(status.capture.state, "active");
    assert_eq!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::PolicyChanged
    );
    assert!(matches!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Attention(_)
    ));

    supervisor.abort();
}

#[tokio::test]
async fn event_stream_reports_unreachable_once_per_outage_and_reconnects() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let supervisor = tokio::spawn(run_event_stream(
        daemon.client(),
        test_stream_config(),
        move |message| {
            let _ = sender.send(message);
        },
    ));
    assert_eq!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Connected
    );
    assert!(matches!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Status(_)
    ));
    assert_eq!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::PolicyChanged
    );
    assert!(matches!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Attention(_)
    ));

    daemon.stop();
    let outage = next_message(&mut receiver).await;
    assert!(
        matches!(outage, DaemonStreamMessage::Unreachable { .. }),
        "got {outage:?}"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        receiver.try_recv().is_err(),
        "repeated retries during one outage must stay silent"
    );

    daemon.start();
    assert_eq!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Connected
    );
    assert!(matches!(
        next_message(&mut receiver).await,
        DaemonStreamMessage::Status(_)
    ));

    supervisor.abort();
}

#[tokio::test]
async fn sessions_refuses_a_response_body_over_the_cap() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    let query = SessionsQuery {
        status: Some("oversize".into()),
        limit: None,
        cursor: None,
    };
    assert_eq!(
        daemon.client().sessions(query).await,
        Err(DaemonError::ResponseTooLarge {
            limit_bytes: MAX_RESPONSE_BYTES as u32
        })
    );
}

#[tokio::test]
async fn event_stream_drops_an_oversized_event_and_reconnects() {
    let mut daemon = FakeDaemon::new();
    daemon.oversize_events.store(true, Ordering::SeqCst);
    daemon.start();
    let (sender, mut receiver) = mpsc::unbounded_channel();
    let supervisor = tokio::spawn(run_event_stream(
        daemon.client(),
        test_stream_config(),
        move |message| {
            let _ = sender.send(message);
        },
    ));

    let event_connections = || {
        daemon
            .recorded()
            .iter()
            .filter(|r| r.path == "/v1/events")
            .count()
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while event_connections() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the supervisor reconnects after an oversized event");
    while let Ok(message) = receiver.try_recv() {
        assert_eq!(
            message,
            DaemonStreamMessage::Connected,
            "nothing from the oversized stream is forwarded"
        );
    }

    daemon.oversize_events.store(false, Ordering::SeqCst);
    loop {
        if let DaemonStreamMessage::Status(status) = next_message(&mut receiver).await {
            assert_eq!(status.capture.state, "active");
            break;
        }
    }
    supervisor.abort();
}

#[tokio::test]
async fn pair_current_answers_the_pending_pairing() {
    let mut daemon = FakeDaemon::new();
    daemon.pending_pairing.store(true, Ordering::SeqCst);
    daemon.start();
    let current = daemon
        .client()
        .pair_current()
        .await
        .unwrap()
        .expect("pending");
    assert_eq!(current.pairing_id, "p1");
    assert_eq!(
        current.verification_uri_complete,
        "https://app.example.dev/companion/pair#code=BCDF-GHJK"
    );
    assert_eq!(current.endpoint.as_deref(), Some("https://app.example.dev"));
    let (method, path, _) = last_request(&daemon);
    assert_eq!((method.as_str(), path.as_str()), ("GET", "/v1/pair"));
}

#[tokio::test]
async fn pair_current_is_none_on_the_daemons_404() {
    let mut daemon = FakeDaemon::new();
    daemon.start();
    assert_eq!(daemon.client().pair_current().await, Ok(None));
}

#[tokio::test]
async fn pair_current_without_a_daemon_is_unreachable() {
    let daemon = FakeDaemon::new();
    assert!(matches!(
        daemon.client().pair_current().await,
        Err(DaemonError::Unreachable { .. })
    ));
}
