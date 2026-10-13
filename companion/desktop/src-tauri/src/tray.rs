// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::commands::open_on_connected_origin;
use crate::daemon::hub::EventHub;
use crate::daemon::DaemonClient;
use crate::platform::tray_host::{
    tray_entry_enabled, tray_menu_entries, TrayMenuEntry, OPEN_COMPANION_LABEL,
};
use crate::platform::PlatformOs;
use crate::popover;
use crate::tray_menu::{
    open_backplane_target, pause_action, pause_menu_label, tray_icon_state, tray_server_line,
    tray_status_line, tray_tooltip, PauseAction, TrayIconState,
};

pub const TRAY_ID: &str = "companion";

const MENU_STATUS: &str = "status";
const MENU_SERVER: &str = "server";
const MENU_PAUSE: &str = "pause";
const MENU_OPEN: &str = "open";
const MENU_OPEN_COMPANION: &str = "open_companion";
const MENU_QUIT: &str = "quit";

struct TrayMenuItems {
    status: MenuItem<Wry>,
    /// "Connected to <host>", inserted right below the status line only while
    /// connected: a disabled item cannot be hidden, only removed.
    server: ServerLine,
    pause: MenuItem<Wry>,
    /// "Open Backplane" (web) or, on Linux, "Open Backplane Companion…".
    open: (TrayMenuEntry, MenuItem<Wry>),
    shown_icon: std::sync::Mutex<Option<(TrayIconState, TrayGlyph)>>,
}
struct ServerLine {
    menu: Menu<Wry>,
    item: MenuItem<Wry>,
    position: usize,
    shown: std::sync::Mutex<bool>,
}

impl ServerLine {
    fn show(&self, line: Option<String>) {
        let mut shown = self
            .shown
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(text) = line {
            let _ = self.item.set_text(text);
            if !*shown && self.menu.insert(&self.item, self.position).is_ok() {
                *shown = true;
            }
        } else if *shown && self.menu.remove(&self.item).is_ok() {
            *shown = false;
        }
    }
}

/// macOS recolours a template glyph for the menu bar; elsewhere the icon is
/// drawn as is, so it has to be picked for the panel behind it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayGlyph {
    Template,
    OnLightPanel,
    OnDarkPanel,
}

pub fn tray_glyph_for(os: PlatformOs, light_panel: Option<bool>) -> TrayGlyph {
    match (os, light_panel) {
        (PlatformOs::Windows, Some(true)) => TrayGlyph::OnLightPanel,
        // Windows 11 ships a dark taskbar.
        (PlatformOs::Windows, _) => TrayGlyph::OnDarkPanel,
        // StatusNotifier hosts can't say what is behind the icon; GNOME's top
        // bar and Plasma's default panel are dark.
        (PlatformOs::Linux | PlatformOs::Unknown, _) => TrayGlyph::OnDarkPanel,
        (PlatformOs::Macos, _) => TrayGlyph::Template,
    }
}

/// 36 px PNGs (scripts/generate-tray-icons.sh); macOS draws them at the
/// 18 pt menu-bar size, so the 2x asset stays crisp on Retina, and Windows
/// scales them to the notification area's size for the display.
pub fn tray_icon_variant_png(state: TrayIconState, glyph: TrayGlyph) -> &'static [u8] {
    match (state, glyph) {
        (TrayIconState::Capturing, TrayGlyph::Template) => {
            include_bytes!("../icons/tray/capturing@2x.png")
        }
        (TrayIconState::Capturing, TrayGlyph::OnLightPanel) => {
            include_bytes!("../icons/tray/capturing-light@2x.png")
        }
        (TrayIconState::Capturing, TrayGlyph::OnDarkPanel) => {
            include_bytes!("../icons/tray/capturing-dark@2x.png")
        }
        (TrayIconState::Paused, TrayGlyph::Template) => {
            include_bytes!("../icons/tray/paused@2x.png")
        }
        (TrayIconState::Paused, TrayGlyph::OnLightPanel) => {
            include_bytes!("../icons/tray/paused-light@2x.png")
        }
        (TrayIconState::Paused, TrayGlyph::OnDarkPanel) => {
            include_bytes!("../icons/tray/paused-dark@2x.png")
        }
        (TrayIconState::Attention, TrayGlyph::Template) => {
            include_bytes!("../icons/tray/attention@2x.png")
        }
        (TrayIconState::Attention, TrayGlyph::OnLightPanel) => {
            include_bytes!("../icons/tray/attention-light@2x.png")
        }
        (TrayIconState::Attention, TrayGlyph::OnDarkPanel) => {
            include_bytes!("../icons/tray/attention-dark@2x.png")
        }
        (TrayIconState::Offline, TrayGlyph::Template) => {
            include_bytes!("../icons/tray/offline@2x.png")
        }
        (TrayIconState::Offline, TrayGlyph::OnLightPanel) => {
            include_bytes!("../icons/tray/offline-light@2x.png")
        }
        (TrayIconState::Offline, TrayGlyph::OnDarkPanel) => {
            include_bytes!("../icons/tray/offline-dark@2x.png")
        }
        (TrayIconState::Disconnected, TrayGlyph::Template) => {
            include_bytes!("../icons/tray/disconnected@2x.png")
        }
        (TrayIconState::Disconnected, TrayGlyph::OnLightPanel) => {
            include_bytes!("../icons/tray/disconnected-light@2x.png")
        }
        (TrayIconState::Disconnected, TrayGlyph::OnDarkPanel) => {
            include_bytes!("../icons/tray/disconnected-dark@2x.png")
        }
    }
}

fn current_glyph() -> TrayGlyph {
    #[cfg(windows)]
    let light_panel = crate::platform::windows_shell::current_taskbar_is_light();
    #[cfg(not(windows))]
    let light_panel = None;
    tray_glyph_for(PlatformOs::current(), light_panel)
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(
        app,
        MENU_STATUS,
        tray_status_line(false, None),
        false,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(app, MENU_PAUSE, pause_menu_label(None), false, None::<&str>)?;
    let server = MenuItem::with_id(app, MENU_SERVER, "", false, None::<&str>)?;
    let entries = tray_menu_entries(PlatformOs::current());
    let server_position = entries
        .iter()
        .position(|entry| *entry == TrayMenuEntry::Status)
        .map_or(0, |status| status + 1);
    let quit = MenuItem::with_id(
        app,
        MENU_QUIT,
        "Quit Backplane Companion",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let mut open = None;
    let menu = Menu::new(app)?;
    for &entry in entries {
        match entry {
            TrayMenuEntry::Status => menu.append(&status)?,
            TrayMenuEntry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            TrayMenuEntry::PauseResume => menu.append(&pause)?,
            TrayMenuEntry::Quit => menu.append(&quit)?,
            TrayMenuEntry::OpenBackplane | TrayMenuEntry::OpenCompanion => {
                let (id, label) = match entry {
                    TrayMenuEntry::OpenCompanion => (MENU_OPEN_COMPANION, OPEN_COMPANION_LABEL),
                    _ => (MENU_OPEN, "Open Backplane"),
                };
                let enabled = tray_entry_enabled(entry, false, false, false);
                let item = MenuItem::with_id(app, id, label, enabled, None::<&str>)?;
                menu.append(&item)?;
                open = Some((entry, item));
            }
        }
    }
    let open = open.expect("every tray menu layout has an open entry");

    let glyph = current_glyph();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(tray_icon_variant_png(
            TrayIconState::Disconnected,
            glyph,
        ))?)
        .icon_as_template(glyph == TrayGlyph::Template)
        .tooltip(tray_tooltip(TrayIconState::Disconnected))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            #[cfg(not(target_os = "macos"))]
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                popover::toggle(tray.app_handle(), Some(rect));
            }
        })
        .build(app)?;

    app.manage(TrayMenuItems {
        status,
        server: ServerLine {
            menu: menu.clone(),
            item: server,
            position: server_position,
            shown: std::sync::Mutex::new(false),
        },
        pause,
        open,
        shown_icon: std::sync::Mutex::new(Some((TrayIconState::Disconnected, glyph))),
    });
    #[cfg(windows)]
    {
        let app = app.clone();
        crate::platform::windows_shell::watch_taskbar_theme(move |_| {
            if let Some(hub) = app.try_state::<Arc<EventHub>>() {
                refresh(&app, &hub);
            }
        });
    }
    // On Linux the tray is added only after the tray-host probe, by which time
    // the daemon's first status has usually arrived; refresh never runs again
    // until something changes, so the menu would keep saying the companion
    // isn't running.
    if let Some(hub) = app.try_state::<Arc<EventHub>>() {
        refresh(app, &hub);
    }
    Ok(())
}

/// Re-derives the tray glyph and menu from the hub's latest state.
pub fn refresh(app: &AppHandle, hub: &EventHub) {
    let Some(items) = app.try_state::<TrayMenuItems>() else {
        return;
    };
    let connected = hub.is_connected();
    let status = hub.latest_status();
    let status = status.as_ref();
    let action = if connected {
        pause_action(status)
    } else {
        None
    };
    let _ = items.status.set_text(tray_status_line(connected, status));
    items.server.show(tray_server_line(connected, status));
    let _ = items.pause.set_text(pause_menu_label(action));
    let _ = items.pause.set_enabled(action.is_some());
    let (open_entry, open_item) = &items.open;
    let _ = open_item.set_enabled(tray_entry_enabled(
        *open_entry,
        connected,
        action.is_some(),
        open_backplane_target(status).is_some(),
    ));

    let icon_state = tray_icon_state(connected, status, hub.attention_count());
    let glyph = current_glyph();
    let mut shown = items
        .shown_icon
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if *shown != Some((icon_state, glyph)) {
        if let (Some(tray), Ok(image)) = (
            app.tray_by_id(TRAY_ID),
            Image::from_bytes(tray_icon_variant_png(icon_state, glyph)),
        ) {
            let _ = tray.set_icon(Some(image));
            let _ = tray.set_icon_as_template(glyph == TrayGlyph::Template);
            let _ = tray.set_tooltip(Some(tray_tooltip(icon_state)));
            *shown = Some((icon_state, glyph));
        }
    }
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        MENU_PAUSE => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { toggle_pause(&app).await });
        }
        MENU_OPEN => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let client = app.state::<DaemonClient>().inner().clone();
                let Ok(status) = client.status().await else {
                    return;
                };
                let Some(target) = open_backplane_target(Some(&status)) else {
                    return;
                };
                if let Err(error) = open_on_connected_origin(&app, &client, &target).await {
                    log::warn!("could not open Backplane: {error}");
                }
            });
        }
        MENU_OPEN_COMPANION => popover::toggle_from_tray(app),
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

async fn toggle_pause(app: &AppHandle) {
    let hub = app.state::<Arc<EventHub>>().inner().clone();
    let client = app.state::<DaemonClient>().inner().clone();
    let outcome = match pause_action(hub.latest_status().as_ref()) {
        Some(PauseAction::Pause) => client.pause().await.map(|_| ()),
        Some(PauseAction::Resume) => client.resume().await.map(|_| ()),
        None => Ok(()),
    };
    if let Err(error) = outcome {
        log::warn!("pause toggle failed: {error}");
    }
    // A popover closes after a menu choice; the Linux window is the user's to close.
    if !cfg!(target_os = "linux") {
        popover::hide(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATES: [TrayIconState; 5] = [
        TrayIconState::Capturing,
        TrayIconState::Paused,
        TrayIconState::Attention,
        TrayIconState::Offline,
        TrayIconState::Disconnected,
    ];

    #[test]
    fn tray_glyph_on_macos_is_the_template_whatever_the_theme() {
        for light_panel in [None, Some(true), Some(false)] {
            assert_eq!(
                tray_glyph_for(PlatformOs::Macos, light_panel),
                TrayGlyph::Template
            );
        }
    }

    #[test]
    fn tray_glyph_on_windows_follows_the_taskbar_theme() {
        assert_eq!(
            tray_glyph_for(PlatformOs::Windows, Some(true)),
            TrayGlyph::OnLightPanel
        );
        assert_eq!(
            tray_glyph_for(PlatformOs::Windows, Some(false)),
            TrayGlyph::OnDarkPanel
        );
    }

    #[test]
    fn tray_glyph_on_windows_with_an_unreadable_theme_assumes_the_dark_taskbar() {
        // Windows 11 ships a dark taskbar; the black template would vanish on it.
        assert_eq!(
            tray_glyph_for(PlatformOs::Windows, None),
            TrayGlyph::OnDarkPanel
        );
    }

    #[test]
    fn tray_glyph_on_linux_is_the_light_glyph_for_a_dark_panel() {
        for os in [PlatformOs::Linux, PlatformOs::Unknown] {
            for light_panel in [None, Some(true), Some(false)] {
                assert_eq!(
                    tray_glyph_for(os, light_panel),
                    TrayGlyph::OnDarkPanel,
                    "{os:?} {light_panel:?}"
                );
            }
        }
    }

    #[test]
    fn tray_icon_on_windows_is_never_the_black_template() {
        for state in STATES {
            let template = tray_icon_variant_png(state, TrayGlyph::Template);
            let on_light = tray_icon_variant_png(state, TrayGlyph::OnLightPanel);
            let on_dark = tray_icon_variant_png(state, TrayGlyph::OnDarkPanel);
            assert_ne!(on_light, template, "{state:?}");
            assert_ne!(on_dark, template, "{state:?}");
            assert_ne!(on_light, on_dark, "{state:?}");
            for png in [template, on_light, on_dark] {
                assert!(Image::from_bytes(png).is_ok(), "{state:?}");
            }
        }
    }
}
