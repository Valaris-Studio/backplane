// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { PlatformInfo } from "../../src/ipc/bindings";

/** The visual baselines are the macOS rendering; every harness answers platform_info with it. */
export const MACOS_PLATFORM: PlatformInfo = { os: "macos", tray_mode: "anchored_popover", updates_supported: true };
