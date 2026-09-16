// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showBrowserNotification } from "../show-browser-notification";

const STORAGE_KEY = "valaris-browser-notifications-enabled";

// A minimal Notification stub recording constructions so we can assert fire/no-fire.
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    FakeNotification.instances.push(this);
  }
  close() {}
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

const COPY = { title: "Valaris", body: "You have a new notification" };

describe("showBrowserNotification", () => {
  beforeEach(() => {
    FakeNotification.instances = [];
    FakeNotification.permission = "granted";
    vi.stubGlobal("Notification", FakeNotification);
    window.localStorage.setItem(STORAGE_KEY, "true");
    setVisibility("hidden");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("fires an OS notification when granted, opted-in, and the tab is hidden", () => {
    showBrowserNotification(COPY);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe("Valaris");
    expect(FakeNotification.instances[0]?.options?.body).toBe(
      "You have a new notification",
    );
  });

  it("does NOT fire when the tab is focused (in-app toast suffices)", () => {
    setVisibility("visible");
    showBrowserNotification(COPY);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("does NOT fire when the user has not opted in", () => {
    window.localStorage.setItem(STORAGE_KEY, "false");
    showBrowserNotification(COPY);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("does NOT fire when permission is not granted", () => {
    FakeNotification.permission = "default";
    showBrowserNotification(COPY);
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("does NOT throw when the Notification API is absent", () => {
    vi.stubGlobal("Notification", undefined);
    expect(() => showBrowserNotification(COPY)).not.toThrow();
  });

  it("navigates to the deep-link url when the notification is clicked", () => {
    const assign = vi.fn();
    const focus = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    vi.stubGlobal("focus", focus);

    showBrowserNotification({ ...COPY, url: "/acme/boards/b1?card=c1" });
    const instance = FakeNotification.instances[0];
    expect(instance).toBeTruthy();
    instance?.onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("/acme/boards/b1?card=c1");
  });

  it("does not navigate on click when no url is provided", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign } as unknown as Location);
    vi.stubGlobal("focus", vi.fn());

    showBrowserNotification(COPY);
    FakeNotification.instances[0]?.onclick?.();

    expect(assign).not.toHaveBeenCalled();
  });
});
