// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

#![cfg(unix)]
//! Contract-D commands against a fake daemon: reveal_agent_config resolves the
//! path from `/v1/agents`, save_diagnostics streams `/v1/diagnostics`. Dialogs
//! and Finder are fakes; HOME is a temp dir.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use backplane_companion_desktop_lib::daemon::client::DIAGNOSTICS_MAX_BYTES;
use backplane_companion_desktop_lib::daemon::{DaemonClient, DaemonError};
use backplane_companion_desktop_lib::native::agent_config::{
    reveal_agent_config, AgentId, Revealer,
};
use backplane_companion_desktop_lib::native::diagnostics::{save_diagnostics, SavedDiagnostics};
use backplane_companion_desktop_lib::native::dialogs::{DialogChoice, NativeDialogs};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

const ZIP_BYTES: &[u8] = b"PK\x03\x04fake-diagnostics-archive";

#[derive(Clone, Copy)]
enum DiagnosticsReply {
    Zip,
    Oversized,
    Failure,
    NotAZip,
}

struct FakeDaemon {
    data_dir: tempfile::TempDir,
    server: JoinHandle<()>,
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl FakeDaemon {
    fn start(agents_json: String, diagnostics: DiagnosticsReply) -> Self {
        // macOS caps sun_path at 104 bytes.
        let data_dir = tempfile::Builder::new()
            .prefix("dk4c")
            .tempdir_in("/tmp")
            .unwrap();
        let socket = data_dir.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        std::fs::write(
            data_dir.path().join("control.json"),
            format!(
                r#"{{"version":1,"socket":"{}","pid":1,"started_at":"2026-09-28T10:00:00Z"}}"#,
                socket.display()
            ),
        )
        .unwrap();
        let agents_json = Arc::new(agents_json);
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            while let Ok((stream, _)) = listener.accept().await {
                connections.spawn(serve(stream, agents_json.clone(), diagnostics));
            }
        });
        Self { data_dir, server }
    }

    fn client(&self) -> DaemonClient {
        DaemonClient::new(self.data_dir.path().to_path_buf())
            .with_request_timeout(Duration::from_secs(5))
    }
}

async fn read_request_line(stream: &mut UnixStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&buffer)
        .lines()
        .next()
        .map(str::to_string)
}

async fn respond(stream: &mut UnixStream, status: &str, content_type: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.shutdown().await;
}

async fn serve(mut stream: UnixStream, agents_json: Arc<String>, diagnostics: DiagnosticsReply) {
    let Some(request_line) = read_request_line(&mut stream).await else {
        return;
    };
    match (request_line.as_str(), diagnostics) {
        ("GET /v1/agents HTTP/1.1", _) => {
            respond(
                &mut stream,
                "200 OK",
                "application/json",
                agents_json.as_bytes(),
            )
            .await
        }
        ("GET /v1/diagnostics HTTP/1.1", DiagnosticsReply::Zip) => {
            respond(&mut stream, "200 OK", "application/zip", ZIP_BYTES).await
        }
        ("GET /v1/diagnostics HTTP/1.1", DiagnosticsReply::Oversized) => {
            let body = vec![b'P'; DIAGNOSTICS_MAX_BYTES + 1];
            respond(&mut stream, "200 OK", "application/zip", &body).await
        }
        ("GET /v1/diagnostics HTTP/1.1", DiagnosticsReply::NotAZip) => {
            respond(&mut stream, "200 OK", "text/html", b"<html>").await
        }
        ("GET /v1/diagnostics HTTP/1.1", DiagnosticsReply::Failure) => {
            respond(
                &mut stream,
                "500 Internal Server Error",
                "application/json",
                br#"{"error":{"code":"internal","message":"zip failed","detail":null}}"#,
            )
            .await
        }
        _ => {
            respond(
                &mut stream,
                "404 Not Found",
                "application/json",
                br#"{"error":{"code":"not_found","message":"No such route","detail":null}}"#,
            )
            .await
        }
    }
}

fn agents_with(id: &str, config_path: &Path) -> String {
    serde_json::json!([{
        "id": id,
        "presence": {"installed": true, "version": "1.0", "config_path": config_path},
        "integration": {"state": "configured", "config_path": config_path, "problems": [], "notes": []},
        "action": null,
        "telemetry": null
    }])
    .to_string()
}

#[derive(Default)]
struct RecordingRevealer(Mutex<Vec<PathBuf>>);

impl Revealer for RecordingRevealer {
    fn reveal(&self, path: &Path) -> std::io::Result<()> {
        self.0.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

struct FailingRevealer;

impl Revealer for FailingRevealer {
    fn reveal(&self, _path: &Path) -> std::io::Result<()> {
        Err(std::io::Error::other("open exited 1"))
    }
}

fn home_with_config(relative: &str) -> (tempfile::TempDir, PathBuf) {
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join(relative);
    std::fs::create_dir_all(config.parent().unwrap()).unwrap();
    std::fs::write(&config, "{}").unwrap();
    (home, config)
}

#[tokio::test]
async fn reveal_agent_config_reveals_the_daemon_reported_path() {
    let (home, config) = home_with_config(".claude/settings.json");
    let daemon = FakeDaemon::start(agents_with("claude_code", &config), DiagnosticsReply::Zip);
    let revealer = RecordingRevealer::default();
    reveal_agent_config(
        &daemon.client(),
        AgentId::ClaudeCode,
        Some(home.path()),
        &revealer,
    )
    .await
    .unwrap();
    assert_eq!(
        *revealer.0.lock().unwrap(),
        vec![config.canonicalize().unwrap()]
    );
}

#[tokio::test]
async fn reveal_agent_config_refuses_an_agent_the_daemon_does_not_list() {
    let (home, config) = home_with_config(".claude/settings.json");
    let daemon = FakeDaemon::start(agents_with("claude_code", &config), DiagnosticsReply::Zip);
    let revealer = RecordingRevealer::default();
    let outcome = reveal_agent_config(
        &daemon.client(),
        AgentId::PiCli,
        Some(home.path()),
        &revealer,
    )
    .await;
    assert!(
        matches!(outcome, Err(DaemonError::InvalidInput { .. })),
        "{outcome:?}"
    );
    assert!(revealer.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reveal_agent_config_refuses_a_path_outside_home() {
    let (home, _) = home_with_config(".claude/settings.json");
    let (_elsewhere, outside) = home_with_config("etc/config.toml");
    let daemon = FakeDaemon::start(agents_with("codex_cli", &outside), DiagnosticsReply::Zip);
    let revealer = RecordingRevealer::default();
    let outcome = reveal_agent_config(
        &daemon.client(),
        AgentId::CodexCli,
        Some(home.path()),
        &revealer,
    )
    .await;
    assert!(
        matches!(outcome, Err(DaemonError::InvalidInput { .. })),
        "{outcome:?}"
    );
    assert!(revealer.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reveal_agent_config_reports_a_failed_reveal() {
    let (home, config) = home_with_config(".pi/settings.json");
    let daemon = FakeDaemon::start(agents_with("pi_cli", &config), DiagnosticsReply::Zip);
    let outcome = reveal_agent_config(
        &daemon.client(),
        AgentId::PiCli,
        Some(home.path()),
        &FailingRevealer,
    )
    .await;
    assert!(
        matches!(outcome, Err(DaemonError::Local { .. })),
        "{outcome:?}"
    );
}

struct SaveTo {
    answer: Option<PathBuf>,
    asked: Mutex<Vec<(Option<PathBuf>, String)>>,
}

impl SaveTo {
    fn new(answer: Option<PathBuf>) -> Self {
        Self {
            answer,
            asked: Mutex::new(Vec::new()),
        }
    }
}

impl NativeDialogs for SaveTo {
    fn pick_folder(&self) -> DialogChoice {
        unreachable!("save_diagnostics never picks a folder")
    }
    fn choose_save_path(&self, directory: Option<&Path>, file_name: &str) -> DialogChoice {
        self.asked
            .lock()
            .unwrap()
            .push((directory.map(Path::to_path_buf), file_name.to_string()));
        let (sender, receiver) = oneshot::channel();
        let _ = sender.send(self.answer.clone());
        receiver
    }
}

fn on_2026_09_28() -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(1_790_596_800)
}

#[tokio::test]
async fn save_diagnostics_writes_the_zip_where_the_user_chose() {
    let daemon = FakeDaemon::start("[]".into(), DiagnosticsReply::Zip);
    let downloads = tempfile::tempdir().unwrap();
    let target = downloads.path().join("support.zip");
    let dialogs = SaveTo::new(Some(target.clone()));
    let saved = save_diagnostics(
        &daemon.client(),
        &dialogs,
        Some(downloads.path()),
        on_2026_09_28(),
    )
    .await
    .unwrap();
    assert_eq!(
        saved,
        SavedDiagnostics {
            saved: true,
            file_name: Some("support.zip".into())
        }
    );
    assert_eq!(std::fs::read(&target).unwrap(), ZIP_BYTES);
    assert_eq!(
        *dialogs.asked.lock().unwrap(),
        vec![(
            Some(downloads.path().to_path_buf()),
            "backplane-diagnostics-2026-09-28.zip".to_string()
        )]
    );
}

#[tokio::test]
async fn save_diagnostics_cancelled_writes_nothing() {
    let daemon = FakeDaemon::start("[]".into(), DiagnosticsReply::Zip);
    let downloads = tempfile::tempdir().unwrap();
    let saved = save_diagnostics(
        &daemon.client(),
        &SaveTo::new(None),
        Some(downloads.path()),
        on_2026_09_28(),
    )
    .await
    .unwrap();
    assert_eq!(
        saved,
        SavedDiagnostics {
            saved: false,
            file_name: None
        }
    );
    assert_eq!(std::fs::read_dir(downloads.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn save_diagnostics_with_the_daemon_down_never_opens_a_dialog() {
    let no_daemon = tempfile::tempdir().unwrap();
    let client = DaemonClient::new(no_daemon.path().to_path_buf());
    let dialogs = SaveTo::new(Some(no_daemon.path().join("x.zip")));
    let outcome = save_diagnostics(&client, &dialogs, None, on_2026_09_28()).await;
    assert!(
        matches!(outcome, Err(DaemonError::Unreachable { .. })),
        "{outcome:?}"
    );
    assert!(dialogs.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn save_diagnostics_surfaces_the_daemon_error_envelope() {
    let daemon = FakeDaemon::start("[]".into(), DiagnosticsReply::Failure);
    let dialogs = SaveTo::new(None);
    let outcome = save_diagnostics(&daemon.client(), &dialogs, None, on_2026_09_28()).await;
    assert!(
        matches!(&outcome, Err(DaemonError::Api { status: 500, code, .. }) if code == "internal"),
        "{outcome:?}"
    );
    assert!(dialogs.asked.lock().unwrap().is_empty());
}

#[tokio::test]
async fn save_diagnostics_refuses_a_body_that_is_not_a_zip() {
    let daemon = FakeDaemon::start("[]".into(), DiagnosticsReply::NotAZip);
    let outcome =
        save_diagnostics(&daemon.client(), &SaveTo::new(None), None, on_2026_09_28()).await;
    assert!(
        matches!(outcome, Err(DaemonError::Protocol { .. })),
        "{outcome:?}"
    );
}

#[tokio::test]
async fn save_diagnostics_refuses_a_zip_over_its_cap() {
    let daemon = FakeDaemon::start("[]".into(), DiagnosticsReply::Oversized);
    let outcome =
        save_diagnostics(&daemon.client(), &SaveTo::new(None), None, on_2026_09_28()).await;
    assert_eq!(
        outcome,
        Err(DaemonError::ResponseTooLarge {
            limit_bytes: DIAGNOSTICS_MAX_BYTES as u32
        })
    );
}

#[tokio::test]
async fn save_diagnostics_reports_a_failed_write() {
    let daemon = FakeDaemon::start("[]".into(), DiagnosticsReply::Zip);
    let downloads = tempfile::tempdir().unwrap();
    let unwritable = downloads.path().join("missing-dir/diag.zip");
    let outcome = save_diagnostics(
        &daemon.client(),
        &SaveTo::new(Some(unwritable)),
        Some(downloads.path()),
        on_2026_09_28(),
    )
    .await;
    assert!(
        matches!(outcome, Err(DaemonError::Local { .. })),
        "{outcome:?}"
    );
}
