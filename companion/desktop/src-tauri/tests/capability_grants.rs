// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! The popover's capability is the webview's whole attack surface: exactly
//! core:default, the header drag grant, and one grant per app command, and no plugin permission, so
//! dialogs, autostart, notifications, fs, opener and the updater stay
//! reachable from Rust only. This file owns the full exact set; update_grants.rs
//! pins the updater's own subset.

use std::collections::BTreeSet;
use std::path::PathBuf;

const APP_COMMANDS: &[&str] = &[
    "status",
    "pause",
    "resume",
    "projects",
    "agents",
    "boards",
    "sessions",
    "pair_start",
    "pair_poll",
    "pair_cancel",
    "rename",
    "disconnect",
    "version",
    "subscribe_events",
    "open_backplane_url",
    "app_location",
    "enable_capture",
    "capture_repair",
    "check_for_update",
    "install_update",
    "last_update_result",
    "update_channel_get",
    "update_channel_set",
    "pick_project_folder",
    "reveal_agent_config",
    "save_diagnostics",
    "launch_at_login_get",
    "launch_at_login_set",
    "notifications_get",
    "notifications_set",
    "hide_popover",
    "queue_flush",
    "agent_install",
    "agent_uninstall",
    "update_settings",
    "mapping_create",
    "mapping_update",
    "mapping_delete",
    "project_ignore",
    "project_unignore",
    "session_get",
    "session_usage",
    "display_path",
    "companion_uninstall",
    "start_companion_service",
    "install_agent_hooks",
    "pair_current",
    "quit_app",
    "platform_info",
    "agent_access_get",
    "agent_access_set",
    "open_uv_install_page",
    "onboarding_active_set",
];

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn popover_permissions() -> BTreeSet<String> {
    let raw = std::fs::read_to_string(manifest_dir().join("capabilities/popover.json")).unwrap();
    let capability: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["popover"]));
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|permission| permission.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn app_commands_cover_contract_a_and_the_native_commands() {
    assert_eq!(APP_COMMANDS.len(), 53);
}

#[test]
fn popover_capability_grants_exactly_the_app_commands() {
    let mut expected: BTreeSet<String> = APP_COMMANDS
        .iter()
        .map(|command| format!("allow-{}", command.replace('_', "-")))
        .collect();
    expected.insert("core:default".into());
    // Dragging the undecorated popover by its header (startDragging in JS).
    expected.insert("core:window:allow-start-dragging".into());
    assert_eq!(popover_permissions(), expected);
}

#[test]
fn popover_capability_grants_no_plugin_permission() {
    for permission in popover_permissions() {
        for plugin in [
            "dialog:",
            "autostart:",
            "notification:",
            "fs:",
            "opener:",
            "shell:",
            "updater:",
            "process:",
        ] {
            assert!(
                !permission.starts_with(plugin),
                "{permission} reaches JS; only Rust commands may use {plugin}"
            );
        }
    }
}

#[test]
fn build_manifest_declares_every_app_command() {
    let build_script = std::fs::read_to_string(manifest_dir().join("build.rs")).unwrap();
    for command in APP_COMMANDS {
        assert!(
            build_script.contains(&format!("\"{command}\"")),
            "build.rs APP_COMMANDS is missing {command}"
        );
    }
}

#[test]
fn no_other_capability_file_exists() {
    let names: Vec<String> = std::fs::read_dir(manifest_dir().join("capabilities"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["popover.json".to_string()]);
}
