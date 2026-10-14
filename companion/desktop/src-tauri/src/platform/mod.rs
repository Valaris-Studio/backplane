// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! What differs between macOS, Windows and Linux. Every rule is a function of
//! a `PlatformOs` value rather than of `cfg`, so each platform's behaviour is
//! tested on whichever host runs the suite.

pub mod appimage;
pub mod autostart;
pub mod install;
#[cfg(target_os = "linux")]
pub mod linux_startup;
pub mod reveal;
pub mod tray_host;
#[cfg(any(windows, test))]
pub mod windows_shell;

use serde::Serialize;
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PlatformOs {
    Macos,
    Windows,
    Linux,
    /// Anything else gets the most restrictive behaviour and neutral copy.
    Unknown,
}

impl PlatformOs {
    /// Maps `std::env::consts::OS`.
    pub fn from_target(os: &str) -> Self {
        match os {
            "macos" => Self::Macos,
            "windows" => Self::Windows,
            "linux" => Self::Linux,
            _ => Self::Unknown,
        }
    }

    pub fn current() -> Self {
        Self::from_target(std::env::consts::OS)
    }
}

/// How the tray icon brings the app forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TrayMode {
    /// A click drops the popover under the menu bar icon.
    AnchoredPopover,
    /// Left click toggles a flyout above the notification area; right click opens the menu.
    Flyout,
    /// The menu is the way in (clicks and the icon's position are unreliable),
    /// and it opens a normal window.
    MenuWindow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Type)]
pub struct PlatformInfo {
    pub os: PlatformOs,
    pub tray_mode: TrayMode,
    /// In-app updates need a signed bundle swap, which only exists on macOS.
    pub updates_supported: bool,
}

pub fn platform_info_for(os: PlatformOs) -> PlatformInfo {
    let tray_mode = match os {
        PlatformOs::Macos => TrayMode::AnchoredPopover,
        PlatformOs::Windows => TrayMode::Flyout,
        PlatformOs::Linux | PlatformOs::Unknown => TrayMode::MenuWindow,
    };
    PlatformInfo {
        os,
        tray_mode,
        updates_supported: os == PlatformOs::Macos,
    }
}

/// Lets the webview pick its copy (Finder or File Explorer, menu bar or tray)
/// without guessing from the user agent.
#[tauri::command]
#[specta::specta]
pub fn platform_info() -> PlatformInfo {
    platform_info_for(PlatformOs::current())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_info_reports_tray_mode_per_os() {
        assert_eq!(
            platform_info_for(PlatformOs::Macos).tray_mode,
            TrayMode::AnchoredPopover
        );
        assert_eq!(
            platform_info_for(PlatformOs::Windows).tray_mode,
            TrayMode::Flyout
        );
        assert_eq!(
            platform_info_for(PlatformOs::Linux).tray_mode,
            TrayMode::MenuWindow
        );
    }

    #[test]
    fn platform_info_on_an_unknown_os_needs_no_tray_click_and_offers_no_updates() {
        let info = platform_info_for(PlatformOs::Unknown);
        assert_eq!(info.tray_mode, TrayMode::MenuWindow);
        assert!(!info.updates_supported);
    }

    #[test]
    fn platform_info_offers_updates_only_on_macos() {
        assert!(platform_info_for(PlatformOs::Macos).updates_supported);
        for os in [PlatformOs::Windows, PlatformOs::Linux, PlatformOs::Unknown] {
            assert!(!platform_info_for(os).updates_supported, "{os:?}");
        }
    }

    #[test]
    fn platform_os_maps_the_rust_target_names() {
        assert_eq!(PlatformOs::from_target("macos"), PlatformOs::Macos);
        assert_eq!(PlatformOs::from_target("windows"), PlatformOs::Windows);
        assert_eq!(PlatformOs::from_target("linux"), PlatformOs::Linux);
    }

    #[test]
    fn platform_os_treats_any_other_target_as_unknown() {
        for target in ["freebsd", "ios", "android", "Macos", "darwin", ""] {
            assert_eq!(
                PlatformOs::from_target(target),
                PlatformOs::Unknown,
                "{target}"
            );
        }
    }

    #[test]
    fn platform_info_serializes_snake_case_for_the_webview() {
        let json = serde_json::to_value(platform_info_for(PlatformOs::Macos)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "os": "macos",
                "tray_mode": "anchored_popover",
                "updates_supported": true
            })
        );
    }
}
