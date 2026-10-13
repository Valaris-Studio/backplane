// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_opener::OpenerExt;

use crate::capture::{
    self, AgentHooksReport, AppLocation, CaptureError, CaptureRepaired, EnableCaptureReport,
    ProcessRunner, ServiceStartReport, UninstallReport,
};
use crate::daemon::hub::EventHub;
use crate::daemon::types::*;
use crate::daemon::{DaemonClient, DaemonError};
use crate::native::agent_config::AgentId;
use crate::native::app_data;
use crate::native::commands::AutostartLoginItem;
use crate::opener::{allowed_web_origin, validate_opener_url, PairingOrigin};
use crate::platform::PlatformOs;

#[tauri::command]
#[specta::specta]
pub async fn status(client: State<'_, DaemonClient>) -> Result<CompanionStatus, DaemonError> {
    client.status().await
}

#[tauri::command]
#[specta::specta]
pub async fn pause(client: State<'_, DaemonClient>) -> Result<PauseState, DaemonError> {
    client.pause().await
}

#[tauri::command]
#[specta::specta]
pub async fn resume(client: State<'_, DaemonClient>) -> Result<PauseState, DaemonError> {
    client.resume().await
}

#[tauri::command]
#[specta::specta]
pub async fn projects(client: State<'_, DaemonClient>) -> Result<ProjectsOverview, DaemonError> {
    client.projects().await
}

#[tauri::command]
#[specta::specta]
pub async fn agents(client: State<'_, DaemonClient>) -> Result<Vec<AgentEntry>, DaemonError> {
    client.agents().await
}

#[tauri::command]
#[specta::specta]
pub async fn boards(client: State<'_, DaemonClient>) -> Result<BoardsOverview, DaemonError> {
    client.boards().await
}

#[tauri::command]
#[specta::specta]
pub async fn sessions(
    client: State<'_, DaemonClient>,
    query: SessionsQuery,
) -> Result<SessionsPage, DaemonError> {
    client.sessions(query).await
}

/// Asks the uploader to retry now, skipping its backoff once (contract v1.6).
#[tauri::command]
#[specta::specta]
pub async fn queue_flush(client: State<'_, DaemonClient>) -> Result<QueueFlush, DaemonError> {
    client.queue_flush().await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_install(
    client: State<'_, DaemonClient>,
    agent_id: AgentId,
) -> Result<AgentEntry, DaemonError> {
    client.agent_install(agent_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_uninstall(
    client: State<'_, DaemonClient>,
    agent_id: AgentId,
) -> Result<AgentEntry, DaemonError> {
    client.agent_uninstall(agent_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_settings(
    client: State<'_, DaemonClient>,
    update: SettingsUpdate,
) -> Result<Settings, DaemonError> {
    client.update_settings(update).await
}

#[tauri::command]
#[specta::specta]
pub async fn mapping_create(
    client: State<'_, DaemonClient>,
    req: MappingCreate,
) -> Result<Mapping, DaemonError> {
    client.mapping_create(req).await
}

#[tauri::command]
#[specta::specta]
pub async fn mapping_update(
    client: State<'_, DaemonClient>,
    id: String,
    update: MappingUpdate,
) -> Result<Mapping, DaemonError> {
    client.mapping_update(&id, update).await
}

#[tauri::command]
#[specta::specta]
pub async fn mapping_delete(
    client: State<'_, DaemonClient>,
    id: String,
) -> Result<DeletedMapping, DaemonError> {
    client.mapping_delete(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_access_get(client: State<'_, DaemonClient>) -> Result<AgentAccess, DaemonError> {
    client.agent_access().await
}

#[tauri::command]
#[specta::specta]
pub async fn agent_access_set(
    client: State<'_, DaemonClient>,
    mapping_id: String,
    enabled: bool,
) -> Result<AgentAccess, DaemonError> {
    client.agent_access_set(&mapping_id, enabled).await
}

/// Agents start Backplane's tools with `uvx`; this is the one page outside the
/// Backplane origin the webview may open, and it takes no URL from JS.
pub const UV_INSTALL_PAGE: &str = "https://docs.astral.sh/uv/getting-started/installation/";

#[tauri::command]
#[specta::specta]
pub fn open_uv_install_page(app: AppHandle) -> Result<(), DaemonError> {
    app.opener()
        .open_url(UV_INSTALL_PAGE, None::<&str>)
        .map_err(|error| DaemonError::protocol(error.to_string()))
}

/// The webview reports whether onboarding shows, so agent notifications wait
/// for it to finish; the flag is all it can set.
#[tauri::command]
#[specta::specta]
pub fn onboarding_active_set(engine: State<'_, crate::notifications::SharedEngine>, active: bool) {
    crate::notifications::lock_engine(&engine).set_onboarding_active(active);
}

/// The path comes from the daemon's own discovered/ignored lists; it must be
/// absolute and is never read here.
#[tauri::command]
#[specta::specta]
pub async fn project_ignore(
    client: State<'_, DaemonClient>,
    path: String,
) -> Result<IgnoredProject, DaemonError> {
    client.project_ignore(&path).await
}

#[tauri::command]
#[specta::specta]
pub async fn project_unignore(
    client: State<'_, DaemonClient>,
    path: String,
) -> Result<UnignoredProject, DaemonError> {
    client.project_unignore(&path).await
}

#[tauri::command]
#[specta::specta]
pub async fn session_get(
    client: State<'_, DaemonClient>,
    id: String,
) -> Result<SessionDetail, DaemonError> {
    client.session_get(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn session_usage(
    client: State<'_, DaemonClient>,
    id: String,
) -> Result<SessionUsage, DaemonError> {
    client.session_usage(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn pair_start(
    client: State<'_, DaemonClient>,
    pairing: State<'_, PairingOrigin>,
    endpoint: String,
    name: Option<String>,
    replace: Option<bool>,
) -> Result<PairingTicket, DaemonError> {
    let ticket = client
        .pair_start(endpoint.clone(), name, replace.unwrap_or(false))
        .await?;
    pairing.remember(&ticket, &endpoint);
    Ok(ticket)
}

/// The pairing still waiting for approval, so onboarding can resume after a
/// relaunch; null when there is none.
#[tauri::command]
#[specta::specta]
pub async fn pair_current(
    client: State<'_, DaemonClient>,
    pairing: State<'_, PairingOrigin>,
) -> Result<Option<PairingTicket>, DaemonError> {
    let current = client.pair_current().await?;
    if let Some(ticket) = &current {
        match ticket.endpoint.as_deref() {
            Some(endpoint) => pairing.remember(ticket, endpoint),
            None => pairing.settle(&ticket.pairing_id),
        }
    }
    Ok(current)
}

#[tauri::command]
#[specta::specta]
pub async fn pair_poll(
    client: State<'_, DaemonClient>,
    pairing: State<'_, PairingOrigin>,
    pairing_id: String,
) -> Result<PairingProgress, DaemonError> {
    let progress = client.pair_poll(&pairing_id).await;
    if pairing_settled(&progress) {
        pairing.settle(&pairing_id);
    }
    progress
}

/// Connected, or a terminal or unknown pairing: its page may no longer open.
fn pairing_settled(progress: &Result<PairingProgress, DaemonError>) -> bool {
    match progress {
        Ok(PairingProgress::Pending | PairingProgress::Persisting) => false,
        Ok(PairingProgress::Connected { .. }) => true,
        Err(DaemonError::Api { code, .. }) => matches!(
            code.as_str(),
            "pairing_denied" | "pairing_expired" | "pairing_failed" | "not_found"
        ),
        Err(_) => false,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn pair_cancel(
    client: State<'_, DaemonClient>,
    pairing: State<'_, PairingOrigin>,
    pairing_id: String,
) -> Result<PairingCancelled, DaemonError> {
    pairing.settle(&pairing_id);
    client.pair_cancel(&pairing_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn rename(
    client: State<'_, DaemonClient>,
    name: String,
) -> Result<InstallationName, DaemonError> {
    client.rename(name).await
}

#[tauri::command]
#[specta::specta]
pub async fn disconnect(client: State<'_, DaemonClient>) -> Result<DisconnectResult, DaemonError> {
    client.disconnect().await
}

#[tauri::command]
#[specta::specta]
pub async fn version(client: State<'_, DaemonClient>) -> Result<VersionReport, DaemonError> {
    client.version().await
}

/// Attaches this webview to the live daemon stream; the current state is
/// replayed immediately, so a reloaded page never waits for the next change.
#[tauri::command]
#[specta::specta]
pub fn subscribe_events(
    webview: Webview,
    hub: State<'_, Arc<EventHub>>,
    on_event: Channel<DaemonStreamMessage>,
) {
    hub.subscribe(
        webview.label(),
        Box::new(move |message| on_event.send(message.clone()).is_ok()),
    );
}

#[tauri::command]
#[specta::specta]
pub async fn open_backplane_url(
    app: AppHandle,
    client: State<'_, DaemonClient>,
    url: String,
) -> Result<(), DaemonError> {
    open_on_connected_origin(&app, &client, &url).await
}

pub async fn open_on_connected_origin(
    app: &AppHandle,
    client: &DaemonClient,
    url: &str,
) -> Result<(), DaemonError> {
    // Unconnected, the daemon may still answer status; unreachable, only a
    // pending pairing's page can open.
    let status = client.status().await.ok();
    let pairing_origin = app
        .try_state::<PairingOrigin>()
        .and_then(|pairing| pairing.current(std::time::Instant::now()));
    let target = validate_opener_url(
        url,
        allowed_web_origin(status.as_ref()),
        pairing_origin.as_deref(),
    )?;
    app.opener()
        .open_url(target.as_str(), None::<&str>)
        .map_err(|error| DaemonError::protocol(error.to_string()))
}

/// The real path of the running app: symlinks resolved so the login service,
/// hooks and updater name the real install. An executable that cannot be
/// resolved is never trusted to be installed.
pub fn running_executable() -> Result<std::path::PathBuf, CaptureError> {
    canonical_executable(std::env::current_exe())
}

fn canonical_executable(
    executable: std::io::Result<std::path::PathBuf>,
) -> Result<std::path::PathBuf, CaptureError> {
    let executable = executable.map_err(|error| CaptureError::NotInApplications {
        path: error.to_string(),
    })?;
    executable
        .canonicalize()
        .map_err(|_| CaptureError::NotInApplications {
            path: executable.to_string_lossy().into_owned(),
        })
}

/// Where the app runs from, so the UI can ask for a proper install first.
#[tauri::command]
#[specta::specta]
pub fn app_location() -> Result<AppLocation, CaptureError> {
    Ok(capture::app_location(&running_executable()?))
}

/// Installs the bundled companion's LaunchAgent and agent hooks. Takes no
/// arguments: the program, its arguments and its environment are all fixed here.
#[tauri::command]
#[specta::specta]
pub async fn enable_capture() -> Result<EnableCaptureReport, CaptureError> {
    let companion = capture::bundled_companion(&running_executable()?)?;
    let environment = capture::companion_environment(|name| std::env::var_os(name));
    tauri::async_runtime::spawn_blocking(move || {
        capture::enable_capture(&ProcessRunner, &companion, &environment)
    })
    .await
    .map_err(|error| CaptureError::CompanionFailed {
        step: "enable".into(),
        exit_code: None,
        message: error.to_string(),
    })?
}

/// Installs and starts only the LaunchAgent, so the daemon (and pairing)
/// runs before any connection. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn start_companion_service() -> Result<ServiceStartReport, CaptureError> {
    let companion = capture::bundled_companion(&running_executable()?)?;
    let environment = capture::companion_environment(|name| std::env::var_os(name));
    tauri::async_runtime::spawn_blocking(move || {
        capture::start_companion_service(&ProcessRunner, &companion, &environment)
    })
    .await
    .map_err(|error| CaptureError::CompanionFailed {
        step: "service".into(),
        exit_code: None,
        message: error.to_string(),
    })?
}

/// Hooks for the agents the policy enables (every present agent when null).
#[tauri::command]
#[specta::specta]
pub async fn install_agent_hooks() -> Result<AgentHooksReport, CaptureError> {
    let companion = capture::bundled_companion(&running_executable()?)?;
    let environment = capture::companion_environment(|name| std::env::var_os(name));
    tauri::async_runtime::spawn_blocking(move || {
        capture::install_agent_hooks(&ProcessRunner, &companion, &environment)
    })
    .await
    .map_err(|error| CaptureError::CompanionFailed {
        step: "agents".into(),
        exit_code: None,
        message: error.to_string(),
    })?
}

/// Remove Companion. Takes no arguments: Rust picks the bundled binary, the
/// steps and the scrubbed environment, as for `enable_capture`.
#[tauri::command]
#[specta::specta]
pub async fn companion_uninstall(app: AppHandle) -> Result<UninstallReport, CaptureError> {
    let companion = capture::companion_for_removal(&running_executable()?)?;
    let environment = capture::companion_environment(|name| std::env::var_os(name));
    let login_item = AutostartLoginItem(app.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        capture::companion_uninstall(&ProcessRunner, &companion, &environment, &login_item)
    })
    .await
    .map_err(|error| CaptureError::CompanionFailed {
        step: "uninstall".into(),
        exit_code: None,
        message: error.to_string(),
    })?;
    if app_data::removal_due(&result) {
        // Token I/O and the staging folder's removal block; keep them off the async runtime.
        let arming = app.clone();
        if let Err(error) =
            tauri::async_runtime::spawn_blocking(move || arm_app_data_removal(&arming)).await
        {
            log::warn!("app data left behind: arming the removal stopped: {error}");
        }
    }
    result
}

/// The webview still runs from these folders, so they go once the app exits.
/// The AppImage's staged companion ran the now-stopped daemon, so it goes now.
fn arm_app_data_removal(app: &AppHandle) {
    let resolver = app.path();
    let Ok(home) = resolver.home_dir() else {
        log::warn!("app data left behind: no home folder");
        return;
    };
    if PlatformOs::current() == PlatformOs::Linux {
        match app_data::remove_appimage_staging(&home) {
            app_data::AppDataOutcome::Removed | app_data::AppDataOutcome::Absent => {}
            outcome => log::warn!("the AppImage staging folder was left behind: {outcome:?}"),
        }
    }
    let Ok(token_dir) = resolver.app_local_data_dir() else {
        log::warn!("app data left behind: no local data folder for the removal token");
        return;
    };
    let resolved: Vec<_> = [
        resolver.app_config_dir(),
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_cache_dir(),
        resolver.app_log_dir(),
    ]
    .into_iter()
    .filter_map(Result::ok)
    .collect();
    let paths = app_data::app_data_paths(PlatformOs::current(), &resolved, &home);
    if let Err(error) = app
        .state::<app_data::PendingAppDataRemoval>()
        .arm(paths, &token_dir)
    {
        log::warn!("app data left behind: the removal could not be armed: {error}");
    }
}

/// The launch-time LaunchAgent repair, kept for a webview that subscribes
/// after the `CaptureRepaired` event already fired.
#[derive(Default)]
pub struct LaunchRepair(std::sync::Mutex<Option<CaptureRepaired>>);

impl LaunchRepair {
    pub fn record(&self, repaired: CaptureRepaired) {
        *self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(repaired);
    }
}

#[tauri::command]
#[specta::specta]
pub fn capture_repair(repair: State<'_, LaunchRepair>) -> Option<CaptureRepaired> {
    repair
        .0
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api(code: &str) -> Result<PairingProgress, DaemonError> {
        Err(DaemonError::Api {
            status: 410,
            code: code.into(),
            message: String::new(),
            detail: None,
        })
    }

    #[test]
    fn canonical_executable_fails_closed_when_the_path_cannot_be_resolved() {
        let missing = std::path::PathBuf::from("/Applications/Gone.app/Contents/MacOS/app");
        assert!(matches!(
            canonical_executable(Ok(missing)),
            Err(CaptureError::NotInApplications { .. })
        ));
        assert!(matches!(
            canonical_executable(Err(std::io::Error::other("no exe"))),
            Err(CaptureError::NotInApplications { .. })
        ));
    }

    #[test]
    #[cfg(unix)]
    fn canonical_executable_resolves_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::write(&real, "").unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            canonical_executable(Ok(link)).unwrap(),
            real.canonicalize().unwrap()
        );
    }

    #[test]
    fn pairing_settled_on_connection_terminal_codes_and_an_unknown_pairing() {
        assert!(pairing_settled(&Ok(PairingProgress::Connected {
            installation_id: "i".into(),
            old_server_revoked: None,
        })));
        for code in [
            "pairing_denied",
            "pairing_expired",
            "pairing_failed",
            "not_found",
        ] {
            assert!(pairing_settled(&api(code)), "{code}");
        }
    }

    #[test]
    fn uv_install_page_is_a_fixed_https_page_on_astral() {
        let page = url::Url::parse(UV_INSTALL_PAGE).unwrap();
        assert_eq!(
            (page.scheme(), page.host_str()),
            ("https", Some("docs.astral.sh"))
        );
    }

    #[test]
    fn pairing_not_settled_while_pending_or_on_a_transient_failure() {
        assert!(!pairing_settled(&Ok(PairingProgress::Pending)));
        assert!(!pairing_settled(&Ok(PairingProgress::Persisting)));
        assert!(!pairing_settled(&api("server_unreachable")));
        assert!(!pairing_settled(&Err(DaemonError::Timeout)));
    }
}
