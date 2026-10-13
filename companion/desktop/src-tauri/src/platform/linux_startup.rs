// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Linux startup: ask the session bus for a StatusNotifier host (off the UI
//! thread, since at login the panel may still be starting), then either add
//! the tray icon or make the window the app and explain the missing tray once.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use super::autostart::launched_at_login;
use super::tray_host::{
    probe_session_bus, startup_plan, wait_for_tray_host, TrayHost, LOGIN_PROBE_ATTEMPTS,
};
use super::PlatformOs;
use crate::{popover, tray};

const EXPLAINED_MARKER: &str = "tray-host-explained";
const NO_TRAY_TITLE: &str = "No system tray on this desktop";
const NO_TRAY_MESSAGE: &str = "Backplane Companion couldn't find a system tray here, so it opens \
as a window instead. Closing the window quits the app; capture keeps running in the background.\n\n\
To get a tray icon on GNOME, install the \"AppIndicator and KStatusNotifierItem Support\" \
extension, then log out and back in.";

pub fn start(app: &AppHandle) -> tauri::Result<()> {
    let close_quits = Arc::new(AtomicBool::new(false));
    popover::install(app, close_quits.clone())?;
    let at_login = launched_at_login(std::env::args_os());
    let app = app.clone();
    std::thread::Builder::new()
        .name("tray-host-probe".into())
        .spawn(move || {
            let attempts = if at_login { LOGIN_PROBE_ATTEMPTS } else { 1 };
            let host = wait_for_tray_host(attempts, probe_session_bus, std::thread::sleep);
            let main = app.clone();
            let _ = app.run_on_main_thread(move || apply(&main, host, at_login, &close_quits));
        })?;
    Ok(())
}

fn apply(app: &AppHandle, probed: TrayHost, at_login: bool, close_quits: &AtomicBool) {
    let host = match probed {
        // A host that vanished between the probe and now must not take the
        // app down, nor leave it with neither a tray icon nor a way to quit.
        TrayHost::Present => match tray::install(app) {
            Ok(()) => TrayHost::Present,
            Err(error) => {
                log::warn!("the tray icon could not be added: {error}");
                TrayHost::Absent
            }
        },
        other => {
            log::info!("no StatusNotifier host ({other:?}); the window is the app");
            other
        }
    };
    let marker = app
        .path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(EXPLAINED_MARKER));
    let explained = marker.as_ref().is_some_and(|marker| marker.exists());
    let plan = startup_plan(PlatformOs::Linux, host, at_login, explained);
    close_quits.store(plan.close_quits, Ordering::SeqCst);
    if plan.show_window {
        popover::toggle(app, None);
    }
    if plan.explain_missing_tray {
        app.dialog()
            .message(NO_TRAY_MESSAGE)
            .title(NO_TRAY_TITLE)
            .kind(MessageDialogKind::Info)
            .show(move |_| {
                if let Some(marker) = marker {
                    let _ = marker.parent().map(std::fs::create_dir_all);
                    let _ = std::fs::write(marker, b"");
                }
            });
    }
}
