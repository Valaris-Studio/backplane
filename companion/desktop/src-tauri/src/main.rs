// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::ExitCode;

use backplane_companion_desktop_lib::native::app_data;

fn main() -> ExitCode {
    if let Some(paths) = app_data::removal_helper_paths(std::env::args_os()) {
        return app_data::run_removal_helper(&paths);
    }
    backplane_companion_desktop_lib::run();
    ExitCode::SUCCESS
}
