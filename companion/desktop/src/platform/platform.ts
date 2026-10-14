// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { commands, type PlatformInfo } from "../ipc/bindings";

export type PlatformOs = PlatformInfo["os"];

const KNOWN_OS: ReadonlySet<string> = new Set<PlatformOs>(["macos", "windows", "linux"]);

/** Matches Rust's `platform_info_for(Unknown)`: neutral copy, menu-first tray, no in-app updates. */
const UNKNOWN_PLATFORM: PlatformInfo = { os: "unknown", tray_mode: "menu_window", updates_supported: false };

// Fixed for the app's lifetime: set once by loadPlatform() before the first render.
let current: PlatformInfo = UNKNOWN_PLATFORM;

export function currentPlatform(): PlatformInfo {
  return current;
}

/** Never fails: a shell that can't answer, or names an os this build doesn't know, gets the neutral platform. */
export async function loadPlatform(): Promise<PlatformInfo> {
  try {
    const reported = await commands.platformInfo();
    current = KNOWN_OS.has(reported.os) ? reported : UNKNOWN_PLATFORM;
  } catch {
    current = UNKNOWN_PLATFORM;
  }
  return current;
}

const INFO_FOR_TESTS: Record<PlatformOs, PlatformInfo> = {
  macos: { os: "macos", tray_mode: "anchored_popover", updates_supported: true },
  windows: { os: "windows", tray_mode: "flyout", updates_supported: false },
  linux: { os: "linux", tray_mode: "menu_window", updates_supported: false },
  unknown: UNKNOWN_PLATFORM,
};

export function setPlatformForTests(os: PlatformOs): void {
  current = INFO_FOR_TESTS[os];
}
