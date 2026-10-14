// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

pub mod bindings;
pub mod capture;
pub mod commands;
pub mod daemon;
pub mod native;
pub mod notifications;
pub mod opener;
pub mod platform;
pub mod popover;
pub mod tray;
pub mod tray_menu;
pub mod update;

use std::sync::Arc;

use tauri::Manager;

use daemon::hub::EventHub;
use daemon::stream::{run_event_stream, StreamConfig};
use daemon::types::DaemonStreamMessage;
use daemon::DaemonClient;

/// The launch-at-login LaunchAgent's label: the app's bundle identifier, so it
/// never collides with the companion daemon's own `dev.backplane.companion`.
const LOGIN_ITEM_LABEL: &str = native::app_data::APP_IDENTIFIER;

#[cfg(all(feature = "e2e-webdriver", not(debug_assertions)))]
compile_error!("e2e-webdriver embeds a WebDriver server; it is for debug test builds only");

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta = bindings::specta_builder();
    let hub = Arc::new(EventHub::default());

    let builder = tauri::Builder::default()
        // Must be first: a second launch has to hand off before anything else initialises.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            popover::toggle_from_tray(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        // Rust-side only: JS holds no opener permission and link clicks are not intercepted.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        // Rust-side only, like the opener: the popover capability grants none
        // of their permissions, so JS reaches them only through contract-D commands.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(autostart_plugin());
    // Rust-side only: the webview gets update::commands, never the plugin's IPC.
    #[cfg(target_os = "macos")]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_nspanel::init());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_positioner::init());
    #[cfg(feature = "e2e-webdriver")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .manage(DaemonClient::from_environment())
        .manage(hub.clone())
        .manage(commands::LaunchRepair::default())
        .manage(native::app_data::PendingAppDataRemoval::default())
        .manage(opener::PairingOrigin::default())
        .manage(update::commands::InstallGuard::default())
        .invoke_handler(specta.invoke_handler())
        .setup(move |app| {
            specta.mount_events(app);
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            #[cfg(target_os = "linux")]
            platform::linux_startup::start(app.handle())?;
            #[cfg(not(target_os = "linux"))]
            {
                tray::install(app.handle())?;
                popover::install(app.handle())?;
            }
            let preference =
                native::preferences::NotificationPreference::load(app.path().app_config_dir().ok());
            app.manage(notifications::start(app.handle(), &hub, preference.flag()));
            app.manage(preference);
            start_event_stream(app.handle().clone(), hub.clone());
            start_launch_repair(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Backplane Companion")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                native::app_data::spawn_helper_if_armed(
                    &app.state::<native::app_data::PendingAppDataRemoval>(),
                );
            }
        });
}

/// macOS gets a LaunchAgent; Windows the HKCU Run key and Linux an XDG
/// autostart entry, both of which the plugin picks by itself.
fn autostart_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_autostart::Builder::new().app_name(LOGIN_ITEM_LABEL);
    #[cfg(target_os = "macos")]
    let builder = builder.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    builder.build()
}

fn start_event_stream(app: tauri::AppHandle, hub: Arc<EventHub>) {
    let client = app.state::<DaemonClient>().inner().clone();
    tauri::async_runtime::spawn(run_event_stream(
        client,
        StreamConfig::default(),
        move |message| {
            if let DaemonStreamMessage::Pairing(event) = &message {
                if event.state != "pending" {
                    app.state::<opener::PairingOrigin>()
                        .settle(&event.pairing_id);
                }
            }
            hub.publish(message);
            tray::refresh(&app, &hub);
        },
    ));
}

/// Off the UI thread: re-points a LaunchAgent left behind by a moved app,
/// then confirms (or rolls back) an update the previous run installed.
fn start_launch_repair(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        repair_moved_app(&app);
        update::commands::finish_update_on_launch(&app);
    });
}

fn repair_moved_app(app: &tauri::AppHandle) {
    let Ok(executable) = commands::running_executable() else {
        return;
    };
    let environment = capture::companion_environment(|name| std::env::var_os(name));
    match capture::repair_moved_service(&capture::ProcessRunner, &executable, &environment) {
        Ok(Some(repaired)) => {
            log::info!(
                "capture repaired: LaunchAgent now starts {}",
                repaired.companion_path
            );
            app.state::<commands::LaunchRepair>()
                .record(repaired.clone());
            if let Some(engine) = app.try_state::<notifications::SharedEngine>() {
                notifications::lock_engine(&engine).capture_repaired();
            }
            if let Err(error) = tauri_specta::Event::emit(&repaired, app) {
                log::warn!("capture repaired, but the event was not delivered: {error}");
            }
        }
        Ok(None) => {}
        Err(error) => log::warn!("capture repair after a move failed: {error}"),
    }
}
