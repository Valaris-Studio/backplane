// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

/// Every app command, declared so each needs an explicit `allow-*` grant in a
/// capability; without a manifest Tauri lets any window invoke any command.
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
    "pick_project_folder",
    "reveal_agent_config",
    "save_diagnostics",
    "launch_at_login_get",
    "launch_at_login_set",
    "notifications_get",
    "notifications_set",
    "hide_popover",
    "check_for_update",
    "install_update",
    "last_update_result",
    "update_channel_get",
    "update_channel_set",
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

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
