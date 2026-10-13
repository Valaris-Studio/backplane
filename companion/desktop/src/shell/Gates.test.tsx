// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { setPlatformForTests } from "../platform/platform";
import { resetServiceStartForTests } from "../stores/companion-service";
import { mockDaemonIpc } from "../test/daemon-ipc";
import { NotRunning } from "./Gates";

const SERVICE_REPORT = {
  companion_path: "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion",
  service: { definition: "~/Library/LaunchAgents/dev.backplane.companion.plist", installed: true, current: true, enabled: true, running: true },
  daemon_running: true,
  replaced_service: false,
};

const settle = () => act(async () => {});

afterEach(() => resetServiceStartForTests());

describe("NotRunning gate", () => {
  it("asks to move the app when Rust refuses a copy outside Applications", async () => {
    mockDaemonIpc({
      app_location: () => ({ in_applications: false, path: "/home/me/Downloads/Backplane Companion.app" }),
      start_companion_service: () => {
        throw { kind: "not_in_applications", path: "/home/me/Downloads/Backplane Companion.app" };
      },
    });
    render(<NotRunning />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Move Backplane Companion to your Applications folder");
  });

  it("asks for the installer instead of the Applications folder off the Mac", async () => {
    setPlatformForTests("linux");
    mockDaemonIpc({
      app_location: () => ({ in_applications: false, path: "/tmp/.mount_x/usr/bin/backplane-companion-desktop" }),
      start_companion_service: () => {
        throw { kind: "ephemeral_location", path: "/tmp/.mount_x/usr/bin/backplane-companion-desktop" };
      },
    });
    render(<NotRunning />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Install Backplane Companion from its package, then try again.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Applications");
  });

  it("starts the service once on its own when the app is in Applications", async () => {
    const daemon = mockDaemonIpc({
      app_location: () => ({ in_applications: true, path: "/Applications/Backplane Companion.app" }),
      start_companion_service: () => SERVICE_REPORT,
    });
    const { unmount } = render(<NotRunning />);
    await settle();
    unmount();
    render(<NotRunning />);
    await settle();
    expect(daemon.invoked().filter((command) => command === "start_companion_service")).toHaveLength(1);
  });

  it("never starts the service on its own outside Applications", async () => {
    const daemon = mockDaemonIpc({
      app_location: () => ({ in_applications: false, path: "/home/me/Downloads/Backplane Companion.app" }),
      start_companion_service: () => SERVICE_REPORT,
    });
    render(<NotRunning />);
    await settle();
    expect(daemon.invoked()).not.toContain("start_companion_service");
  });

  it("does nothing on its own when the app location is unknown", async () => {
    const daemon = mockDaemonIpc();
    render(<NotRunning />);
    await settle();
    expect(daemon.invoked()).toEqual(["app_location"]);
  });

  it("Retry starts the service again, even after the automatic attempt", async () => {
    const daemon = mockDaemonIpc({
      app_location: () => ({ in_applications: true, path: "/Applications/Backplane Companion.app" }),
      start_companion_service: () => SERVICE_REPORT,
    });
    render(<NotRunning />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(daemon.invoked().filter((command) => command === "start_companion_service")).toHaveLength(2);
  });

  it("says why a start failed and keeps Retry available", async () => {
    mockDaemonIpc({
      app_location: () => ({ in_applications: false, path: "/Volumes/Backplane Companion/Backplane Companion.app" }),
      start_companion_service: () => {
        throw { kind: "ephemeral_location", path: "/Volumes/Backplane Companion/Backplane Companion.app" };
      },
    });
    render(<NotRunning />);
    await settle();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Move Backplane Companion to your Applications folder");
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  });
});
