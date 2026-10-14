// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";

import { mockDaemonIpc } from "../test/daemon-ipc";
import { currentPlatform, loadPlatform, setPlatformForTests } from "./platform";

afterEach(() => setPlatformForTests("macos"));

describe("platform info", () => {
  it("adopts what the shell reports", async () => {
    mockDaemonIpc({ platform_info: () => ({ os: "linux", tray_mode: "menu_window", updates_supported: false }) });
    await loadPlatform();
    expect(currentPlatform()).toEqual({ os: "linux", tray_mode: "menu_window", updates_supported: false });
  });

  it("falls back to the neutral unknown platform when the shell can't answer", async () => {
    mockDaemonIpc({
      platform_info: () => {
        throw "command platform_info not allowed";
      },
    });
    await loadPlatform();
    expect(currentPlatform()).toEqual({ os: "unknown", tray_mode: "menu_window", updates_supported: false });
  });

  it("treats an os this build doesn't know as unknown, never as a Mac", async () => {
    mockDaemonIpc({ platform_info: () => ({ os: "freebsd", tray_mode: "anchored_popover", updates_supported: true }) });
    await loadPlatform();
    expect(currentPlatform()).toEqual({ os: "unknown", tray_mode: "menu_window", updates_supported: false });
  });
});
