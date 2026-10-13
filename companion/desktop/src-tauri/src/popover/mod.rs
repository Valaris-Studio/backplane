// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

pub mod position;
pub mod reopen;

// `windows` also serves any other target that is neither macOS nor Linux.
// Every module is built under test on each host so clippy and the tests
// type-check it against the real Tauri and positioner APIs.
#[cfg(any(target_os = "linux", test))]
#[cfg_attr(all(not(target_os = "linux"), test), allow(dead_code))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(not(any(target_os = "macos", target_os = "linux")), test))]
#[cfg_attr(
    all(any(target_os = "macos", target_os = "linux"), test),
    allow(dead_code)
)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::{activate_for_dialog, install, refocus_after_dialog, toggle};
#[cfg(target_os = "macos")]
pub use macos::{activate_for_dialog, install, refocus_after_dialog, toggle};
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub use windows::{activate_for_dialog, install, refocus_after_dialog, toggle};

use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Manager};

use crate::tray::TRAY_ID;
use reopen::{PlacementMemory, PopoverPlacement, PopoverWindow};

pub const POPOVER_LABEL: &str = "popover";

/// Shows the popover under the tray icon's last known rect; used when a second
/// launch of the app asks the running instance to come forward.
pub fn toggle_from_tray(app: &AppHandle) {
    let anchor = app
        .tray_by_id(TRAY_ID)
        .and_then(|tray| tray.rect().ok().flatten());
    toggle(app, anchor);
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPOVER_LABEL) {
        let _ = window.hide();
    }
}

static PLACEMENT_MEMORY: Mutex<PlacementMemory> = Mutex::new(PlacementMemory::new());

/// Positions the popover just before it opens (see reopen.rs).
#[cfg_attr(all(target_os = "linux", not(test)), allow(dead_code))]
fn place_for_reopen(window: &impl PopoverWindow, tray_anchored: Option<PopoverPlacement>) {
    let mut memory = PLACEMENT_MEMORY
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    reopen::place_for_reopen(window, &mut memory, tray_anchored);
}
