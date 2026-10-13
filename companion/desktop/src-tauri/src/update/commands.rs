// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Manager, State};
#[cfg(target_os = "macos")]
use tauri_plugin_updater::UpdaterExt;

use super::flow::{self, Installation, LaunchOutcome, UpdateEffects};
#[cfg(target_os = "macos")]
use super::host::PluginPackage;
use super::host::{BundledCompanion, CodesignTrust, DiskBundles, SystemClock, RELEASE_TEAM_ID};
use super::{
    updater_key_configured, when_updates_allowed, when_updates_supported, UpdateChannel,
    UpdateError, UpdateFailed, UpdateJournal,
};
use crate::capture;
use crate::commands::running_executable;
use crate::daemon::DaemonClient;
use crate::notifications;
use crate::platform::install::app_bundle_of;
use crate::platform::PlatformOs;

#[cfg(target_os = "macos")]
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct UpdateCheck {
    pub available: bool,
    /// The offered version, or the running one when nothing newer is offered.
    pub version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// One install at a time: a second click must not stop the daemon twice or
/// race the bundle swap.
#[derive(Default)]
pub struct InstallGuard(AtomicBool);

fn journal(app: &AppHandle) -> Result<UpdateJournal, UpdateError> {
    app.path()
        .app_config_dir()
        .map(UpdateJournal::new)
        .map_err(|error| UpdateError::Settings {
            message: error.to_string(),
        })
}

fn updater_key(app: &AppHandle) -> bool {
    updater_key_configured(app.config().plugins.0.get("updater"))
}

fn running_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(target_os = "macos")]
async fn find_update(
    app: &AppHandle,
    journal: &UpdateJournal,
) -> Result<Option<tauri_plugin_updater::Update>, UpdateError> {
    let check_error = |error: tauri_plugin_updater::Error| UpdateError::Check {
        message: error.to_string(),
    };
    let channel = journal.channel();
    let running = running_version(app);
    let highest_seen = journal.highest_offered(channel);
    let offered_journal = journal.clone();
    // The minisign signature stops a tampered archive, not a stale manifest:
    // anyone who can replay an old latest.json can freeze clients on an old
    // (validly signed) release. The highest-seen floor below only stops a
    // walk back to below a version this client already saw announced; true
    // freeze protection rests on the release bucket's IAM (accepted risk).
    app.updater_builder()
        .endpoints(vec![channel.endpoint()])
        .map_err(check_error)?
        .timeout(CHECK_TIMEOUT)
        .version_comparator(move |_current, release| {
            let offered = release.version.to_string();
            let acceptable =
                super::offer_is_acceptable(&running, &offered, highest_seen.as_deref());
            if let Err(error) = offered_journal.record_offered(channel, &offered) {
                log::warn!("update: recording the offered version failed: {error}");
            }
            acceptable
        })
        .build()
        .map_err(check_error)?
        .check()
        .await
        .map_err(check_error)
}

#[tauri::command]
#[specta::specta]
pub async fn check_for_update(app: AppHandle) -> Result<UpdateCheck, UpdateError> {
    let journal = when_updates_allowed(PlatformOs::current(), updater_key(&app), || journal(&app))?;
    check_offered(&app, &journal).await
}

#[cfg(target_os = "macos")]
async fn check_offered(
    app: &AppHandle,
    journal: &UpdateJournal,
) -> Result<UpdateCheck, UpdateError> {
    Ok(match find_update(app, journal).await? {
        Some(update) => UpdateCheck {
            available: true,
            version: update.version.clone(),
            notes: update.body.clone(),
            date: update
                .raw_json
                .get("pub_date")
                .and_then(|date| date.as_str())
                .map(str::to_string),
        },
        None => UpdateCheck {
            available: false,
            version: running_version(app),
            notes: None,
            date: None,
        },
    })
}

/// Never reached: `when_updates_supported` refuses first off macOS (D6).
#[cfg(not(target_os = "macos"))]
async fn check_offered(
    _app: &AppHandle,
    _journal: &UpdateJournal,
) -> Result<UpdateCheck, UpdateError> {
    Err(UpdateError::UpdatesUnavailableOnPlatform)
}

/// Downloads, verifies and installs the offered update, then relaunches;
/// the relaunched app confirms it (see `finish_update_on_launch`).
#[tauri::command]
#[specta::specta]
pub async fn install_update(
    app: AppHandle,
    guard: State<'_, InstallGuard>,
) -> Result<(), UpdateError> {
    if guard.0.swap(true, Ordering::SeqCst) {
        return Err(UpdateError::Busy);
    }
    let installed = install_offered_update(&app).await;
    guard.0.store(false, Ordering::SeqCst);
    installed?;
    app.restart()
}

struct AppPaths {
    app_bundle: PathBuf,
    companion: BundledCompanion,
}

fn app_paths(app: &AppHandle) -> Result<AppPaths, UpdateError> {
    let not_bundled = |message: String| UpdateError::NotBundled { message };
    let executable = running_executable().map_err(|error| not_bundled(error.to_string()))?;
    // Also refuses a DMG mount or an App Translocation copy.
    let companion =
        capture::bundled_companion(&executable).map_err(|error| not_bundled(error.to_string()))?;
    let app_bundle = app_bundle_of(&executable)
        .ok_or_else(|| not_bundled(executable.display().to_string()))?
        .to_path_buf();
    Ok(AppPaths {
        app_bundle,
        companion: BundledCompanion {
            companion,
            environment: capture::companion_environment(|name| std::env::var_os(name)),
            daemon: app.state::<DaemonClient>().inner().clone(),
        },
    })
}

#[cfg(not(target_os = "macos"))]
async fn install_offered_update(app: &AppHandle) -> Result<(), UpdateError> {
    when_updates_supported(PlatformOs::current(), || journal(app))?;
    Err(UpdateError::UpdatesUnavailableOnPlatform)
}

#[cfg(target_os = "macos")]
async fn install_offered_update(app: &AppHandle) -> Result<(), UpdateError> {
    let journal = when_updates_allowed(PlatformOs::current(), updater_key(app), || journal(app))?;
    let paths = app_paths(app)?;
    let update = find_update(app, &journal)
        .await?
        .ok_or(UpdateError::NoUpdate)?;
    let running_version = running_version(app);
    tauri::async_runtime::spawn_blocking(move || {
        let effects = UpdateEffects {
            companion: &paths.companion,
            bundles: &DiskBundles,
            clock: &SystemClock,
            trust: &CodesignTrust {
                expected_team: RELEASE_TEAM_ID,
            },
        };
        flow::install_update(
            &PluginPackage(update),
            &effects,
            &Installation {
                app_bundle: &paths.app_bundle,
                running_version: &running_version,
                journal: &journal,
            },
        )
    })
    .await
    .map_err(|error| UpdateError::Install {
        message: error.to_string(),
    })?
}

const NOTIFICATION_GRACE_BEFORE_RESTART: Duration = Duration::from_millis(750);

/// At launch, off the UI thread: confirms an update the previous run
/// installed, or rolls it back and relaunches into the restored app.
pub fn finish_update_on_launch(app: &AppHandle) {
    // Off macOS nothing below runs, so the codesign rollback check is never reached.
    let Ok(journal) = when_updates_supported(PlatformOs::current(), || journal(app)) else {
        return;
    };
    let Ok(paths) = app_paths(app) else {
        return;
    };
    let running_version = running_version(app);
    let effects = UpdateEffects {
        companion: &paths.companion,
        bundles: &DiskBundles,
        clock: &SystemClock,
        trust: &CodesignTrust {
            expected_team: RELEASE_TEAM_ID,
        },
    };
    let installation = Installation {
        app_bundle: &paths.app_bundle,
        running_version: &running_version,
        journal: &journal,
    };
    let Some(outcome) = flow::finish_pending_update(&effects, &installation) else {
        return;
    };
    if let Some(engine) = app.try_state::<notifications::SharedEngine>() {
        notifications::lock_engine(&engine).observe_launch_outcome(&outcome);
    }
    match outcome {
        LaunchOutcome::Updated { version } => log::info!("updated to {version}"),
        LaunchOutcome::RolledBack { failure, restored } => {
            log::error!(
                "update to {} rolled back ({:?}): {}",
                failure.to_version,
                failure.reason,
                failure.detail
            );
            if restored {
                // The notification is delivered on a background task; give it
                // a moment before the restart ends this process.
                std::thread::sleep(NOTIFICATION_GRACE_BEFORE_RESTART);
                app.restart();
            }
        }
    }
}

/// The last update that failed and was rolled back (or could not be), for
/// the UI; home paths in `detail` are shown as `~`.
#[tauri::command]
#[specta::specta]
pub fn last_update_result(app: AppHandle) -> Result<Option<UpdateFailed>, UpdateError> {
    let home = app.path().home_dir().unwrap_or_default();
    Ok(journal(&app)?.last_update_result(&home))
}

#[tauri::command]
#[specta::specta]
pub fn update_channel_get(app: AppHandle) -> Result<UpdateChannel, UpdateError> {
    Ok(journal(&app)?.channel())
}

#[tauri::command]
#[specta::specta]
pub fn update_channel_set(
    app: AppHandle,
    channel: UpdateChannel,
) -> Result<UpdateChannel, UpdateError> {
    journal(&app)?.set_channel(channel)
}
