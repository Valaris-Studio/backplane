// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The contract-D commands: thin adapters from Tauri state and plugins to the
//! testable flows in the sibling modules.

use std::path::Path;
use std::time::SystemTime;

use tauri::{AppHandle, Manager, State};
#[cfg(not(target_os = "linux"))]
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use super::agent_config::{self, AgentId};
use super::diagnostics::{self, SavedDiagnostics};
use super::dialog_focus::{SuppressionGuard, POPOVER_BLUR};
use super::dialogs::{self, DialogChoice, NativeDialogs};
use super::display_path::display_path as shown_path;
use super::login_item::{self, LoginItem};
use super::preferences::NotificationPreference;
use crate::daemon::types::DiscoveredProject;
use crate::daemon::{DaemonClient, DaemonError};
use crate::platform::reveal::SystemRevealer;
use crate::popover;

const ZIP_FILTER_NAME: &str = "Zip archive";

/// One native dialog on screen: the popover stays up behind it and the app is
/// brought forward. Moved into the dialog's callback, so whether the callback
/// runs (choice or cancel) or is dropped unrun (an error), the suppression ends.
struct DialogSession {
    app: AppHandle,
    _blur: SuppressionGuard<'static>,
}

impl DialogSession {
    fn open(app: &AppHandle) -> Self {
        let session = Self {
            app: app.clone(),
            _blur: POPOVER_BLUR.suppress(),
        };
        popover::activate_for_dialog(app);
        session
    }

    fn close(self) {
        let app = self.app.clone();
        drop(self);
        popover::refocus_after_dialog(&app);
    }
}

struct TauriDialogs(AppHandle);

impl NativeDialogs for TauriDialogs {
    fn pick_folder(&self) -> DialogChoice {
        let (answer, choice) = oneshot::channel();
        let session = DialogSession::open(&self.0);
        self.0
            .dialog()
            .file()
            .set_can_create_directories(true)
            .pick_folder(move |folder| {
                session.close();
                let _ = answer.send(folder.and_then(|folder| folder.into_path().ok()));
            });
        choice
    }

    fn choose_save_path(&self, directory: Option<&Path>, file_name: &str) -> DialogChoice {
        let (answer, choice) = oneshot::channel();
        let mut builder = self
            .0
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter(ZIP_FILTER_NAME, &["zip"]);
        if let Some(directory) = directory {
            builder = builder.set_directory(directory);
        }
        let session = DialogSession::open(&self.0);
        builder.save_file(move |target| {
            session.close();
            let _ = answer.send(target.and_then(|target| target.into_path().ok()));
        });
        choice
    }
}

/// The handle reaches the autostart plugin; Linux's own writer needs none.
pub(crate) struct AutostartLoginItem(
    #[cfg_attr(target_os = "linux", allow(dead_code))] pub AppHandle,
);

/// Linux writes its own autostart entry (quoted, AppImage-aware) under the
/// plugin's file name; see platform::autostart.
#[cfg(target_os = "linux")]
impl LoginItem for AutostartLoginItem {
    fn is_enabled(&self) -> Result<bool, String> {
        linux_autostart()?.is_enabled()
    }

    fn enable(&self) -> Result<(), String> {
        linux_autostart()?.enable()
    }

    fn disable(&self) -> Result<(), String> {
        linux_autostart()?.disable()
    }
}

#[cfg(target_os = "linux")]
fn linux_autostart() -> Result<crate::platform::autostart::LinuxAutostart, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    crate::platform::autostart::LinuxAutostart::from_environment(
        |name| std::env::var_os(name),
        &executable,
    )
    .ok_or_else(|| "neither XDG_CONFIG_HOME nor HOME is set".into())
}

#[cfg(not(target_os = "linux"))]
impl LoginItem for AutostartLoginItem {
    fn is_enabled(&self) -> Result<bool, String> {
        self.0
            .autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())
    }

    fn enable(&self) -> Result<(), String> {
        self.0
            .autolaunch()
            .enable()
            .map_err(|error| error.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        self.0
            .autolaunch()
            .disable()
            .map_err(|error| error.to_string())
    }
}

/// Projects "Add a folder…": the found project the daemon recorded for the
/// chosen folder, or null when cancelled. The path never comes from JS.
#[tauri::command]
#[specta::specta]
pub async fn pick_project_folder(
    app: AppHandle,
    client: State<'_, DaemonClient>,
) -> Result<Option<DiscoveredProject>, DaemonError> {
    dialogs::pick_project_folder(&TauriDialogs(app), |path| async move {
        client.project_discover(&path).await
    })
    .await
}

/// Shows the agent's config file in the file manager. The path comes from the daemon,
/// never from the webview, and must lie inside the user's home folder.
#[tauri::command]
#[specta::specta]
pub async fn reveal_agent_config(
    app: AppHandle,
    client: State<'_, DaemonClient>,
    agent_id: AgentId,
) -> Result<(), DaemonError> {
    let home = app.path().home_dir().ok();
    agent_config::reveal_agent_config(
        &client,
        agent_id,
        home.as_deref(),
        &SystemRevealer::current(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn save_diagnostics(
    app: AppHandle,
    client: State<'_, DaemonClient>,
) -> Result<SavedDiagnostics, DaemonError> {
    let downloads = app.path().download_dir().ok();
    diagnostics::save_diagnostics(
        &client,
        &TauriDialogs(app.clone()),
        downloads.as_deref(),
        SystemTime::now(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub fn launch_at_login_get(app: AppHandle) -> Result<bool, DaemonError> {
    login_item::launch_at_login(&AutostartLoginItem(app))
}

#[tauri::command]
#[specta::specta]
pub fn launch_at_login_set(app: AppHandle, enabled: bool) -> Result<bool, DaemonError> {
    login_item::set_launch_at_login(&AutostartLoginItem(app), enabled)
}

#[tauri::command]
#[specta::specta]
pub fn notifications_get(preference: State<'_, NotificationPreference>) -> bool {
    preference.enabled()
}

#[tauri::command]
#[specta::specta]
pub fn notifications_set(
    preference: State<'_, NotificationPreference>,
    enabled: bool,
) -> Result<bool, DaemonError> {
    preference.set(enabled)
}

/// Esc at the top level of the popover.
#[tauri::command]
#[specta::specta]
pub fn hide_popover(app: AppHandle) -> Result<(), DaemonError> {
    popover::hide(&app);
    Ok(())
}

/// Quit, as the tray menu does: the only way out of the removed-Companion panel.
#[tauri::command]
#[specta::specta]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// A path as the webview may show it: HOME as `~`, no control or bidi
/// characters, only the base name when it has a `..` segment. Pure string
/// work; nothing is read from disk.
#[tauri::command]
#[specta::specta]
pub fn display_path(app: AppHandle, path: String) -> String {
    let home = app.path().home_dir().ok();
    // APFS and NTFS resolve names case-insensitively by default.
    let case_insensitive = cfg!(any(target_os = "macos", windows));
    shown_path(
        &path,
        home.as_deref().and_then(Path::to_str),
        case_insensitive,
    )
}
