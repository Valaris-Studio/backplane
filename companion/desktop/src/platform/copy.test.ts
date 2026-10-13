// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { platformCopy, type PlatformCopy } from "./copy";
import type { PlatformOs } from "./platform";

const EVERY_OS: PlatformOs[] = ["macos", "windows", "linux", "unknown"];

function everySentence(copy: PlatformCopy): string[] {
  return Object.values(copy).flatMap((value) => (typeof value === "string" ? [value] : Object.values(value as Record<string, string>)));
}

describe("platform copy", () => {
  it('copy renders "Show in Files" on linux, "Show in Explorer" on windows, "Show in Finder" on macos', () => {
    expect(platformCopy("linux").showInFileManager).toBe("Show in Files");
    expect(platformCopy("windows").showInFileManager).toBe("Show in Explorer");
    expect(platformCopy("macos").showInFileManager).toBe("Show in Finder");
  });

  it("keychain explanation names Secret Service on linux", () => {
    const { credentialStore } = platformCopy("linux");
    expect(credentialStore.body).toContain("Secret Service");
    expect(credentialStore.body).not.toMatch(/macOS|keychain/);
  });

  it("keychain explanation names Credential Manager on windows", () => {
    const { credentialStore } = platformCopy("windows");
    expect(credentialStore.body).toContain("Credential Manager");
    expect(credentialStore.body).not.toMatch(/macOS|keychain/);
  });

  it("keeps the macOS wording the app has always shown", () => {
    const mac = platformCopy("macos");
    expect(mac.thisDevice).toBe("this Mac");
    expect(mac.ThisDevice).toBe("This Mac");
    expect(mac.trayLocation).toBe("menu bar");
    expect(mac.copyShortcut).toBe("⌘C");
    expect(mac.quitCodexStep).toBe("Quit Codex with ⌘Q.");
    expect(mac.credentialStore).toEqual({
      title: "Your keychain isn’t available",
      body: "Companion keeps this Mac’s sign-in in the macOS keychain, and it’s locked or unavailable right now. Unlock your Mac (not over SSH) and try again. Nothing was stored.",
    });
    expect(mac.credentialStoreName).toBe("the keychain");
    expect(mac.installFirst).toBe("Move Backplane Companion to your Applications folder, then try again.");
    expect(mac.installFirstBeforeRemoval).toBe("Move Backplane Companion to Applications, then try again. Nothing was removed.");
    expect(mac.loginItemsRefused).toBe("macOS didn’t let Companion change Open at login. Check Login Items in System Settings.");
    expect(mac.fileManagerFailed).toBe("Finder couldn’t show the file.");
  });

  it("names the tray where each platform puts it", () => {
    expect(platformCopy("windows").trayLocation).toBe("notification area");
    expect(platformCopy("linux").trayLocation).toBe("system tray");
  });

  it("keeps the macOS and Windows pause copy the app has always shown", () => {
    for (const os of ["macos", "windows"] as const) {
      expect(platformCopy(os).pauseHowTo).toBe("Click the icon, then the pause button. Or right-click it.");
    }
    expect(platformCopy("macos").pauseAnyTime).toBe("From the menu bar, in one click.");
    expect(platformCopy("windows").pauseAnyTime).toBe("From the notification area, in one click.");
  });

  it("tells Linux to pause from the tray menu or the window, never by clicking the icon", () => {
    const linux = platformCopy("linux");
    expect(linux.pauseAnyTime).toBe("From the tray icon’s menu, or the pause button in this window.");
    expect(linux.pauseHowTo).toBe("Choose Pause capture in the tray icon’s menu, or use the pause button at the top of this window.");
    for (const sentence of [linux.pauseAnyTime, linux.pauseHowTo]) {
      expect(sentence).not.toMatch(/one click|Click the icon|right-click/i);
    }
  });

  it("gives an unknown platform the menu-first pause copy, as its tray is menu-first too", () => {
    const unknown = platformCopy("unknown");
    expect(unknown.pauseAnyTime).toBe(platformCopy("linux").pauseAnyTime);
    expect(unknown.pauseHowTo).toBe(platformCopy("linux").pauseHowTo);
  });

  it("uses Ctrl shortcuts off the Mac", () => {
    for (const os of ["windows", "linux", "unknown"] as const) {
      expect(platformCopy(os).copyShortcut).toBe("Ctrl+C");
    }
  });

  it('unknown platform uses neutral copy, never "Mac"', () => {
    const unknown = platformCopy("unknown");
    expect(unknown.thisDevice).toBe("this computer");
    for (const sentence of everySentence(unknown)) {
      expect(sentence).not.toMatch(/\bMac\b|macOS|Finder|menu bar|keychain|Applications|⌘|Windows|Explorer/);
    }
  });

  it("never mixes another platform's words into Windows or Linux copy", () => {
    for (const sentence of [...everySentence(platformCopy("windows")), ...everySentence(platformCopy("linux"))]) {
      expect(sentence).not.toMatch(/\bMac\b|macOS|Finder|menu bar|keychain|Applications folder|⌘/);
    }
  });

  it("gives every platform every sentence", () => {
    const keys = Object.keys(platformCopy("macos")).sort();
    for (const os of EVERY_OS) {
      const copy = platformCopy(os);
      expect(Object.keys(copy).sort()).toEqual(keys);
      for (const sentence of everySentence(copy)) expect(sentence.trim()).not.toBe("");
    }
  });
});
