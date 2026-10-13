// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

use tauri_specta::{collect_commands, collect_events, Builder, ErrorHandlingMode};

use crate::capture::CaptureRepaired;

use crate::commands;
use crate::native;
use crate::platform;
use crate::update;

pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::status,
            commands::pause,
            commands::resume,
            commands::projects,
            commands::agents,
            commands::boards,
            commands::sessions,
            commands::queue_flush,
            commands::agent_install,
            commands::agent_uninstall,
            commands::update_settings,
            commands::mapping_create,
            commands::mapping_update,
            commands::mapping_delete,
            commands::agent_access_get,
            commands::agent_access_set,
            commands::open_uv_install_page,
            commands::onboarding_active_set,
            commands::project_ignore,
            commands::project_unignore,
            commands::session_get,
            commands::session_usage,
            commands::pair_start,
            commands::pair_poll,
            commands::pair_cancel,
            commands::pair_current,
            commands::rename,
            commands::disconnect,
            commands::version,
            commands::subscribe_events,
            commands::open_backplane_url,
            commands::app_location,
            commands::enable_capture,
            commands::capture_repair,
            commands::companion_uninstall,
            commands::start_companion_service,
            commands::install_agent_hooks,
            native::commands::pick_project_folder,
            native::commands::reveal_agent_config,
            native::commands::save_diagnostics,
            native::commands::launch_at_login_get,
            native::commands::launch_at_login_set,
            native::commands::notifications_get,
            native::commands::notifications_set,
            native::commands::hide_popover,
            native::commands::display_path,
            native::commands::quit_app,
            platform::platform_info,
            update::commands::check_for_update,
            update::commands::install_update,
            update::commands::last_update_result,
            update::commands::update_channel_get,
            update::commands::update_channel_set,
        ])
        .events(collect_events![CaptureRepaired])
        // Rejections are normalised by src/ipc/errors.ts, which also has to
        // cover non-command failures (a missing permission rejects with a string).
        .error_handling(ErrorHandlingMode::Throw)
        // Counters and byte sizes from the daemon stay far below 2^53.
        .dangerously_cast_bigints_to_number()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use specta_typescript::Typescript;

    use super::specta_builder;

    // The licence header every source file carries (scripts/check-license-headers.sh);
    // emitted here so regenerating never drops it.
    const BINDINGS_HEADER: &str =
        "// Copyright (c) 2026 Valaris Studio\n// SPDX-License-Identifier: MIT\n";

    fn committed_bindings_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/bindings.ts")
    }

    fn render_bindings() -> String {
        let scratch = tempfile::tempdir().unwrap();
        let path = scratch.path().join("bindings.ts");
        specta_builder()
            .export(Typescript::default().header(BINDINGS_HEADER), &path)
            .unwrap();
        let rendered = std::fs::read_to_string(path).unwrap();
        let normalized = rendered
            .split('\n')
            .map(|line| line.trim_end_matches([' ', '\t']))
            .collect::<Vec<_>>()
            .join("\n");
        format!("{}\n", normalized.trim_end_matches('\n'))
    }

    #[test]
    fn bindings_match_the_committed_typescript() {
        let committed = std::fs::read_to_string(committed_bindings_path()).unwrap_or_default();
        assert!(
            committed == render_bindings(),
            "src/ipc/bindings.ts is stale: run `pnpm bindings`"
        );
    }

    #[test]
    #[ignore = "writes src/ipc/bindings.ts; run via `pnpm bindings`"]
    fn export_bindings() {
        std::fs::write(committed_bindings_path(), render_bindings()).unwrap();
    }
}
