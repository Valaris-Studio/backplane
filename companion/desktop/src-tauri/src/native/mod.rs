// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//! Contract D: native desktop commands owned by Rust. The webview passes no
//! paths; every path comes from the daemon or a native dialog.

pub mod agent_config;
pub mod app_data;
pub mod commands;
pub mod diagnostics;
pub mod dialog_focus;
pub mod dialogs;
pub mod display_path;
pub mod login_item;
pub mod preferences;
