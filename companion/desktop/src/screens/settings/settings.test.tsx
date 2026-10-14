// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "../../App";
import type { CompanionStatus_Deserialize } from "../../ipc/bindings";
import { push } from "../../shell/navigation";
import { startDaemonStream } from "../../stores/daemon-stream";
import { fixtureStatus, mockDaemonIpc } from "../../test/daemon-ipc";
import { REDUCED_MOTION_QUERY, stubMatchMedia } from "../../test/media";

type Status = CompanionStatus_Deserialize;
type Handler = (args: Record<string, unknown>) => unknown;
type Handlers = Record<string, Handler>;

const fixture = fixtureStatus as Status;
const account = {
  email: "owner@example.dev",
  display_name: null,
  web_origin: "https://app.bp.example.dev",
  device_name: "Ada’s MacBook Pro",
} satisfies NonNullable<Status["account"]>;
const baseStatus: Status = {
  ...fixture,
  installation_id: "7c1e2b40-9d3a-4f7e-8c21-5b0e3d6fa94f",
  account,
  capture: { ...fixture.capture, retention_days: 90 },
};

function withCapture(state: string, patch: Partial<Status> = {}): Status {
  return { ...baseStatus, ...patch, capture: { ...baseStatus.capture, state } };
}

function happyHandlers(): Handlers {
  return {
    launch_at_login_get: () => true,
    launch_at_login_set: ({ enabled }) => enabled,
    notifications_get: () => true,
    notifications_set: ({ enabled }) => enabled,
    update_channel_get: () => "stable",
    update_channel_set: ({ channel }) => channel,
    last_update_result: () => null,
    check_for_update: () => ({ available: false, version: "0.9.0", notes: null, date: null }),
    install_update: () => new Promise(() => {}),
    rename: ({ name }) => ({ name }),
    disconnect: () => ({ connected: false, server_revoked: true }),
    agent_uninstall: ({ agentId }) => ({ id: agentId, presence: null, integration: null, action: null, telemetry: null }),
    save_diagnostics: () => ({ saved: true, file_name: "backplane-diagnostics-2026-09-28.zip" }),
    open_backplane_url: () => null,
    pause: () => ({ paused: true }),
    resume: () => ({ paused: false }),
  };
}

async function renderSettings(status: Status = baseStatus, overrides: Handlers = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const handlers: Handlers = {};
  for (const [command, handler] of Object.entries({ ...happyHandlers(), ...overrides })) {
    handlers[command] = (args) => {
      calls.push([command, args]);
      return handler(args);
    };
  }
  // Reduced motion keeps layer exits short enough to wait for.
  stubMatchMedia(REDUCED_MOTION_QUERY);
  const daemon = mockDaemonIpc(handlers);
  startDaemonStream();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
  });
  act(() => push("settings"));
  await act(async () => {});
  const invoked = (command: string) => calls.filter(([name]) => name === command).map(([, args]) => args);
  return { daemon, calls, invoked };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const toast = () => document.querySelector("[data-toast]");
const errorToast = () => document.querySelector('[data-toast-region="alert"]');
const announcedAsAlert = (text: string) => screen.getByText(text).closest('[role="alert"]');
const row = (name: string | RegExp) => {
  const title = screen.getAllByText(name).find((element) => element.closest("li"));
  if (!title) throw new Error(`no row titled ${String(name)}`);
  return title.closest("li") as HTMLElement;
};

const daemonDown = { kind: "unreachable", reason: "control socket refused the connection" };
const apiError = (code: string, status = 502) => ({ kind: "api", status, code, message: `raw upstream text for ${code}`, detail: null });

describe("Settings screen", () => {
  it("renders as a pushed route with the four groups and the remove actions", async () => {
    await renderSettings();
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("screen-settings")).toBeInTheDocument();
    for (const section of ["This Mac", "Backplane", "Updates", "Diagnostics", "Remove"]) {
      expect(screen.getByRole("heading", { name: section, level: 3 })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Switch server…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove…" })).toBeInTheDocument();
    // Sign out replaced the Remove group's Disconnect row.
    expect(screen.queryByRole("button", { name: "Disconnect…" })).not.toBeInTheDocument();
  });
});

describe("Settings: This Mac", () => {
  it("renames the Mac inline, confirms it and returns focus to Rename", async () => {
    const { invoked } = await renderSettings();
    expect(within(row("Name")).getByText("Ada’s MacBook Pro")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: "Device name, shown on boards next to its sessions" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Ada’s MacBook Pro");
    await userEvent.clear(input);
    await userEvent.type(input, "  Studio Mac  ");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(invoked("rename")).toEqual([{ name: "Studio Mac" }]);
    expect(toast()).toHaveTextContent("Renamed. Boards show the new name on new sessions.");
    expect(within(row("Name")).getByText("Studio Mac")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename…" })).toHaveFocus();
  });

  it("refuses an empty name without calling the daemon", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: /Device name/ });
    await userEvent.clear(input);
    await userEvent.type(input, "   {Enter}");
    expect(invoked("rename")).toEqual([]);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("The name can’t be empty.");
    expect(input).toHaveFocus();
  });

  it("refuses a name over 80 characters", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: /Device name/ });
    await userEvent.clear(input);
    await userEvent.type(input, `${"x".repeat(81)}{Enter}`);
    expect(invoked("rename")).toEqual([]);
    expect(input).toHaveAccessibleDescription("Keep it to 80 characters or fewer.");
  });

  it("counts characters, not UTF-16 units: 41 emoji are accepted", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: /Device name/ });
    await userEvent.clear(input);
    await userEvent.paste("🚀".repeat(41));
    await userEvent.keyboard("{Enter}");
    expect(invoked("rename")).toEqual([{ name: "🚀".repeat(41) }]);
  });

  it("rejects 81 emoji as over 80 characters", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: /Device name/ });
    await userEvent.clear(input);
    await userEvent.paste("🚀".repeat(81));
    await userEvent.keyboard("{Enter}");
    expect(invoked("rename")).toEqual([]);
    expect(input).toHaveAccessibleDescription("Keep it to 80 characters or fewer.");
  });

  it("ignores Escape while a rename is in flight", async () => {
    const rename = deferred<unknown>();
    await renderSettings(baseStatus, { rename: () => rename.promise });
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: /Device name/ });
    await userEvent.clear(input);
    await userEvent.type(input, "Studio Mac{Enter}");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: /Device name/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    await act(async () => rename.resolve({ name: "Studio Mac" }));
    expect(within(row("Name")).getByText("Studio Mac")).toBeInTheDocument();
  });

  it("keeps the editor open with a humane message when the server refuses the rename", async () => {
    await renderSettings(baseStatus, {
      rename: () => {
        throw apiError("server_unreachable");
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    const input = screen.getByRole("textbox", { name: /Device name/ });
    await userEvent.clear(input);
    await userEvent.type(input, "Studio Mac{Enter}");
    expect(input).toHaveAccessibleDescription("Couldn’t reach Backplane, so the name didn’t change. Try again.");
    expect(screen.queryByText(/raw upstream text/)).not.toBeInTheDocument();
    expect(within(row(/Device name/)).queryByText("Studio Mac")).not.toBeInTheDocument();
  });

  it("says the companion isn't running when the daemon is down during a rename", async () => {
    await renderSettings(baseStatus, {
      rename: () => {
        throw daemonDown;
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    await userEvent.type(screen.getByRole("textbox", { name: /Device name/ }), "!{Enter}");
    expect(screen.getByRole("textbox", { name: /Device name/ })).toHaveAccessibleDescription(
      "Companion isn’t running, so the name didn’t change. Try again in a moment.",
    );
  });

  it("cancels the rename on Escape, stays on Settings and puts focus back on Rename", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Rename…" }));
    await userEvent.type(screen.getByRole("textbox", { name: /Device name/ }), " draft{Escape}");
    expect(screen.queryByRole("textbox", { name: /Device name/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename…" })).toHaveFocus();
    expect(screen.getByRole("heading", { name: "Settings", level: 1 })).toBeInTheDocument();
    expect(invoked("rename")).toEqual([]);
  });

  it("reflects and changes Open at login", async () => {
    const { invoked } = await renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Open at login" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    expect(invoked("launch_at_login_set")).toEqual([{ enabled: false }]);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("reverts Open at login and explains when macOS refuses it", async () => {
    await renderSettings(baseStatus, {
      launch_at_login_set: () => {
        throw { kind: "local", message: "SMAppService register failed: Operation not permitted" };
      },
    });
    const toggle = await screen.findByRole("switch", { name: "Open at login" });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(errorToast()).toHaveTextContent("macOS didn’t let Companion change Open at login. Check Login Items in System Settings.");
    expect(screen.queryByText(/SMAppService/)).not.toBeInTheDocument();
  });

  it("pauses and resumes capture like the header does", async () => {
    const { invoked } = await renderSettings();
    const pause = screen.getByRole("switch", { name: "Pause capture" });
    expect(pause).toHaveAttribute("aria-checked", "false");
    await userEvent.click(pause);
    expect(invoked("pause")).toHaveLength(1);
    expect(toast()).toHaveTextContent("Capture paused on this Mac.");
  });

  it("offers Resume when paused locally", async () => {
    const { invoked } = await renderSettings(withCapture("paused_locally", { capture: { ...baseStatus.capture, state: "paused_locally", local_paused: true } }));
    const pause = screen.getByRole("switch", { name: "Pause capture" });
    expect(pause).toHaveAttribute("aria-checked", "true");
    await userEvent.click(pause);
    expect(invoked("resume")).toHaveLength(1);
  });

  it("disables Pause when the server paused capture or the Mac was revoked", async () => {
    await renderSettings(withCapture("paused_by_server"));
    expect(screen.getByRole("switch", { name: "Pause capture" })).toBeDisabled();
  });

  it("disables Pause for a revoked Mac", async () => {
    await renderSettings(withCapture("revoked", { revoked: true }));
    expect(screen.getByRole("switch", { name: "Pause capture" })).toBeDisabled();
  });

  it("says so when pausing fails", async () => {
    await renderSettings(baseStatus, {
      pause: () => {
        throw daemonDown;
      },
    });
    await userEvent.click(screen.getByRole("switch", { name: "Pause capture" }));
    expect(errorToast()).toHaveTextContent("Couldn’t pause capture. Try again in a moment.");
  });

  it("reflects and changes notifications", async () => {
    const { invoked } = await renderSettings(baseStatus, { notifications_get: () => false });
    const toggle = await screen.findByRole("switch", { name: "Notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(invoked("notifications_set")).toEqual([{ enabled: true }]);
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("reverts notifications when the preference can't be saved", async () => {
    await renderSettings(baseStatus, {
      notifications_set: () => {
        throw { kind: "local", message: "EACCES /home/tester/Library/…" };
      },
    });
    const toggle = await screen.findByRole("switch", { name: "Notifications" });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(errorToast()).toHaveTextContent("Couldn’t save the notification setting. Try again.");
    expect(screen.queryByText(/EACCES/)).not.toBeInTheDocument();
  });
});

describe("Settings: Backplane", () => {
  it("shows the server host, the account, a shortened device id and retention", async () => {
    await renderSettings();
    expect(within(row("Connected to")).getByText("app.bp.example.dev")).toBeInTheDocument();
    expect(within(row("Signed in as")).getByText("owner@example.dev")).toBeInTheDocument();
    expect(within(row("Device ID")).getByText("7c1e…a94f")).toBeInTheDocument();
    expect(within(row("Keeps sessions")).getByText("90 days")).toBeInTheDocument();
  });

  it("shows the display name when there is one", async () => {
    await renderSettings({ ...baseStatus, account: { ...account, display_name: "Ada Ruiz" } });
    expect(within(row("Signed in as")).getByText("Ada Ruiz")).toBeInTheDocument();
    expect(within(row("Signed in as")).getByText("owner@example.dev")).toBeInTheDocument();
  });

  it("leaves out rows the daemon has no data for", async () => {
    await renderSettings({ ...baseStatus, account: null, capture: { ...baseStatus.capture, retention_days: null } });
    expect(screen.queryByText("Signed in as")).not.toBeInTheDocument();
    expect(screen.queryByText("Keeps sessions")).not.toBeInTheDocument();
  });

  it("opens the web origin, not the API endpoint", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Open in Backplane" }));
    expect(invoked("open_backplane_url")).toEqual([{ url: "https://app.bp.example.dev/" }]);
  });

  it("falls back to the endpoint when the server sent no web origin", async () => {
    const { invoked } = await renderSettings({ ...baseStatus, account: { ...account, web_origin: null } });
    await userEvent.click(screen.getByRole("button", { name: "Open in Backplane" }));
    expect(invoked("open_backplane_url")).toEqual([{ url: "https://bp.example.dev/" }]);
  });
});

describe("Settings: Updates", () => {
  it("loads the channel and switches it", async () => {
    const { invoked } = await renderSettings(baseStatus, { update_channel_get: () => "beta" });
    const channel = await screen.findByRole("combobox", { name: "Channel" });
    expect(channel).toHaveValue("beta");
    await userEvent.selectOptions(channel, "stable");
    expect(invoked("update_channel_set")).toEqual([{ channel: "stable" }]);
    expect(toast()).toHaveTextContent("Stable channel.");
  });

  it("shows an unknown stored channel as-is, disabled, without coercing it to Stable", async () => {
    const { invoked } = await renderSettings(baseStatus, { update_channel_get: () => "nightly" });
    const channel = await screen.findByRole("combobox", { name: "Channel" });
    await vi.waitFor(() => expect(channel).toHaveValue("nightly"));
    expect(channel).toBeDisabled();
    expect(within(row("Channel")).getByText("This Mac is on the “nightly” channel, which Settings can’t change.")).toBeInTheDocument();
    expect(invoked("update_channel_set")).toEqual([]);
  });

  it("puts the channel back when it can't be saved", async () => {
    await renderSettings(baseStatus, {
      update_channel_set: () => {
        throw { kind: "settings", message: "disk full" };
      },
    });
    const channel = await screen.findByRole("combobox", { name: "Channel" });
    await userEvent.selectOptions(channel, "beta");
    expect(channel).toHaveValue("stable");
    expect(errorToast()).toHaveTextContent("Couldn’t change the update channel. Try again.");
  });

  it("shows the version and checks: checking, then up to date", async () => {
    const check = deferred<unknown>();
    await renderSettings(baseStatus, { check_for_update: () => check.promise });
    expect(within(row("Version")).getByText(/^0\.9\.0/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(within(row("Version")).getByText("Checking…")).toBeInTheDocument();
    await act(async () => check.resolve({ available: false, version: "0.9.0", notes: null, date: null }));
    expect(within(row("Version")).getByText("Up to date")).toBeInTheDocument();
    expect(within(row("Version")).getByText(/checked today at/)).toBeInTheDocument();
  });

  it("offers a restart when an update is available and installs it", async () => {
    const { invoked } = await renderSettings(baseStatus, {
      check_for_update: () => ({ available: true, version: "1.0.0", notes: "Fixes", date: null }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(screen.getByText("Companion 1.0.0 is ready")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(invoked("install_update")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Restarting…" })).toHaveAttribute("aria-busy", "true");
  });

  it("says the update server can't be reached when the check fails offline", async () => {
    await renderSettings(baseStatus, {
      check_for_update: () => {
        throw { kind: "check", message: "error sending request for url (https://releases…): dns error" };
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    expect(within(row("Version")).getByText("Couldn’t reach the update server. Check your connection.")).toBeInTheDocument();
    expect(screen.queryByText(/dns error/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled();
  });

  it("explains a failed download and lets the user retry", async () => {
    await renderSettings(baseStatus, {
      check_for_update: () => ({ available: true, version: "1.0.0", notes: null, date: null }),
      install_update: () => {
        throw { kind: "download", message: "connection reset by peer" };
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(announcedAsAlert("The download didn’t finish. Check your connection and try again.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeEnabled();
    expect(screen.queryByText(/connection reset/)).not.toBeInTheDocument();
  });

  it("refuses an update whose signature doesn't check out", async () => {
    await renderSettings(baseStatus, {
      check_for_update: () => ({ available: true, version: "1.0.0", notes: null, date: null }),
      install_update: () => {
        throw { kind: "signature", message: "minisign: signature mismatch" };
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Check now" }));
    await userEvent.click(screen.getByRole("button", { name: "Restart to update" }));
    expect(announcedAsAlert("The update’s signature didn’t check out, so it wasn’t installed. You’re still on 0.9.0.")).not.toBeNull();
    expect(screen.queryByText(/minisign/)).not.toBeInTheDocument();
  });

  it("warns that the last update was rolled back, with templated copy", async () => {
    await renderSettings(baseStatus, {
      last_update_result: () => ({ from_version: "0.9.0", to_version: "1.0.0", reason: "unhealthy", detail: "~/Library/raw detail", failed_at_unix: 1 }),
    });
    expect(await screen.findByText("The last update didn’t work, so the previous version was restored.")).toBeInTheDocument();
    expect(screen.getByText("Companion 1.0.0 didn’t start up healthy, so you’re back on 0.9.0.")).toBeInTheDocument();
    expect(screen.queryByText(/raw detail/)).not.toBeInTheDocument();
  });

  it("says plainly when the previous version couldn't be restored", async () => {
    await renderSettings(baseStatus, {
      last_update_result: () => ({ from_version: "0.9.0", to_version: "1.0.0", reason: "rollback_copy_untrusted", detail: "not signed", failed_at_unix: 1 }),
    });
    expect(await screen.findByText("The last update didn’t work, and the previous version couldn’t be restored.")).toBeInTheDocument();
  });
});

describe("Settings: Diagnostics", () => {
  it("shows the companion version, service state, queue and last error", async () => {
    await renderSettings();
    expect(within(row("Companion")).getByText("0.9.0")).toBeInTheDocument();
    expect(within(row("Companion")).getByText("Background service running")).toBeInTheDocument();
    expect(within(row("Upload queue")).getByText("4 waiting · 2 KB")).toBeInTheDocument();
    expect(within(row("Last error")).getByText("None")).toBeInTheDocument();
  });

  it("says when the background service isn't running", async () => {
    await renderSettings({ ...baseStatus, daemon_running: false });
    expect(within(row("Companion")).getByText("Background service not running")).toBeInTheDocument();
  });

  it("shows an empty queue as Empty", async () => {
    await renderSettings({ ...baseStatus, queue: { ...baseStatus.queue, records: 0, bytes: 0 } });
    expect(within(row("Upload queue")).getByText("Empty")).toBeInTheDocument();
  });

  it("templates the last error from its code and never shows raw text", async () => {
    await renderSettings({ ...baseStatus, queue: { ...baseStatus.queue, last_error: "unavailable" } });
    expect(within(row("Last error")).getByText("Server unreachable")).toBeInTheDocument();
  });

  it("falls back to a neutral phrase for an unknown error code", async () => {
    await renderSettings({ ...baseStatus, queue: { ...baseStatus.queue, last_error: "dial tcp 10.0.0.1: i/o timeout" } });
    expect(within(row("Last error")).getByText("Unexpected error")).toBeInTheDocument();
    expect(screen.queryByText(/dial tcp/)).not.toBeInTheDocument();
  });

  it("exports diagnostics with a busy state and names the saved file", async () => {
    const save = deferred<unknown>();
    await renderSettings(baseStatus, { save_diagnostics: () => save.promise });
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-busy", "true");
    await act(async () => save.resolve({ saved: true, file_name: "backplane-diagnostics-2026-09-28.zip" }));
    expect(toast()).toHaveTextContent("Saved backplane-diagnostics-2026-09-28.zip");
    expect(screen.getByRole("button", { name: "Saved" })).toBeInTheDocument();
  });

  it("does nothing when the save dialog is cancelled", async () => {
    await renderSettings(baseStatus, { save_diagnostics: () => ({ saved: false, file_name: null }) });
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(toast()).toBeNull();
    expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled();
  });

  it.each([
    [{ kind: "local", message: "the diagnostics could not be saved: EROFS /Volumes/x" }, "Couldn’t save the file there. Try another folder."],
    [apiError("internal", 500), "Companion couldn’t put the diagnostics together. Try again."],
    [daemonDown, "Companion isn’t running, so there’s nothing to export. Try again in a moment."],
    [{ kind: "timeout" }, "Exporting took too long. Try again."],
  ])("explains a refused export (%o)", async (rejection, message) => {
    await renderSettings(baseStatus, {
      save_diagnostics: () => {
        throw rejection;
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(errorToast()).toHaveTextContent(message);
    expect(screen.queryByText(/EROFS|raw upstream/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled();
  });
});

describe("Settings: Sign out", () => {
  it("confirms with the live queue count, Cancel focused, and Escape returns focus", async () => {
    await renderSettings();
    const opener = screen.getByRole("button", { name: "Sign out…" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("alertdialog", { name: "Sign out of app.bp.example.dev?" });
    expect(dialog).toHaveTextContent("Capture stops and this Mac’s sign-in is deleted from the keychain. Agent hooks stay installed but do nothing.");
    expect(dialog).toHaveTextContent("Sessions already uploaded stay in Backplane. 4 uploads haven’t been sent yet and will be deleted.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(opener).toHaveFocus();
  });

  it("says nothing is waiting when the queue is empty", async () => {
    await renderSettings({ ...baseStatus, queue: { ...baseStatus.queue, records: 0 } });
    await userEvent.click(screen.getByRole("button", { name: "Sign out…" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Nothing is waiting to upload.");
  });

  it("signs out and returns to onboarding", async () => {
    const { invoked } = await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Sign out…" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(invoked("disconnect")).toHaveLength(1);
    expect(screen.getByTestId("screen-onboarding")).toBeInTheDocument();
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(toast()).toHaveTextContent("Signed out of app.bp.example.dev.");
  });

  it("still signs out locally when Backplane can't be reached, and says so", async () => {
    await renderSettings(baseStatus, { disconnect: () => ({ connected: false, server_revoked: false }) });
    await userEvent.click(screen.getByRole("button", { name: "Sign out…" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByTestId("screen-onboarding")).toBeInTheDocument();
    expect(toast()).toHaveTextContent(
      "Signed out on this Mac, but app.bp.example.dev couldn’t be reached. Remove this Mac from your devices in Backplane too.",
    );
  });

  it("keeps the dialog open with a humane error when disconnecting fails", async () => {
    await renderSettings(baseStatus, {
      disconnect: () => {
        throw apiError("internal", 500);
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Sign out…" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("This Mac couldn’t be signed out. Try again.");
    expect(screen.queryByText(/raw upstream/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
  });

  it("says the companion isn't running when the daemon is down", async () => {
    await renderSettings(baseStatus, {
      disconnect: () => {
        throw daemonDown;
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Sign out…" }));
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(within(screen.getByRole("alertdialog")).getByRole("alert")).toHaveTextContent(
      "Companion isn’t running, so nothing changed. Try again in a moment.",
    );
  });
});

describe("Settings: Switch server", () => {
  const NEW_SERVER = "https://intern.example.dev";
  const ticket = () => ({
    pairing_id: "pair-switch",
    user_code: "KMTR-XQBW",
    verification_uri: "https://intern.example.dev/companion/pair",
    verification_uri_complete: "https://intern.example.dev/companion/pair#code=KMTR-XQBW",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    interval: 5,
    endpoint: null,
  });
  const switchHandlers = (overrides: Handlers = {}): Handlers => ({
    pair_start: () => ticket(),
    pair_poll: () => ({ state: "pending" }),
    pair_cancel: () => ({ cancelled: true }),
    ...overrides,
  });
  const sheet = () => screen.getByRole("dialog", { name: "Switch server" });
  const daemonCalls = (calls: Array<[string, Record<string, unknown>]>) =>
    calls.map(([name]) => name).filter((name) => ["pair_start", "pair_cancel", "pair_poll", "disconnect"].includes(name));

  async function openSwitch(status: Status = baseStatus, overrides: Handlers = {}) {
    const rendered = await renderSettings(status, switchHandlers(overrides));
    await userEvent.click(screen.getByRole("button", { name: "Switch server…" }));
    return rendered;
  }

  async function continueTo(url: string) {
    const field = within(sheet()).getByRole("textbox", { name: "Server address" });
    await userEvent.clear(field);
    await userEvent.type(field, url);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Continue" }));
  }

  it("renders the connected host in the Backplane section", async () => {
    await renderSettings();
    expect(within(row("Connected to")).getByText("app.bp.example.dev")).toBeInTheDocument();
    expect(row("Sign out")).toHaveTextContent("app.bp.example.dev");
  });

  it("opens a sheet asking for the new server, saying the current one keeps capturing", async () => {
    await openSwitch();
    expect(within(sheet()).getByRole("textbox", { name: "Server address" })).toHaveFocus();
    expect(sheet()).toHaveTextContent("keeps capturing for app.bp.example.dev until you approve");
  });

  it("makes no daemon call when cancelled before a code is requested", async () => {
    const { calls } = await openSwitch();
    await userEvent.type(within(sheet()).getByRole("textbox", { name: "Server address" }), NEW_SERVER);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(daemonCalls(calls)).toEqual([]);
  });

  it("refuses the server it is already connected to without calling the daemon", async () => {
    const { calls } = await openSwitch();
    await continueTo("https://bp.example.dev/");
    expect(sheet()).toHaveTextContent("This Mac is already connected to app.bp.example.dev.");
    expect(daemonCalls(calls)).toEqual([]);
  });

  it("requests a replacing code under this Mac's name and states what waits for the old server", async () => {
    const { invoked } = await openSwitch();
    await continueTo(NEW_SERVER);
    expect(invoked("pair_start")).toEqual([{ endpoint: NEW_SERVER, name: "Ada’s MacBook Pro", replace: true }]);
    expect(within(sheet()).getByRole("group", { name: "Code KMTR-XQBW" })).toBeInTheDocument();
    expect(sheet()).toHaveTextContent("When you approve, up to 4 waiting uploads are sent to app.bp.example.dev first, then this Mac signs out of it.");
  });

  it("cancels the pending code, and only that, when closed at the code", async () => {
    const { calls, invoked } = await openSwitch();
    await continueTo(NEW_SERVER);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoked("pair_cancel")).toEqual([{ pairingId: "pair-switch" }]);
    expect(daemonCalls(calls)).toEqual(["pair_start", "pair_cancel"]);
    expect(screen.getByTestId("screen-settings")).toBeInTheDocument();
  });

  it("ends on Done naming both servers once the code is approved", async () => {
    const { daemon, invoked } = await openSwitch(baseStatus, {
      pair_poll: () => ({ state: "connected", installation_id: "inst-2", old_server_revoked: true }),
    });
    await continueTo(NEW_SERVER);
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "connected" } }));
    await vi.waitFor(() => expect(sheet()).toHaveTextContent("Now connected to intern.example.dev. Signed out of app.bp.example.dev."));
    expect(screen.queryByText(/couldn’t be reached/)).not.toBeInTheDocument();
    await userEvent.click(within(sheet()).getByRole("button", { name: "Done" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(invoked("pair_cancel")).toEqual([]);
  });

  it("says so when the old server couldn't be told", async () => {
    const { daemon } = await openSwitch(baseStatus, {
      pair_poll: () => ({ state: "connected", installation_id: "inst-2", old_server_revoked: false }),
    });
    await continueTo(NEW_SERVER);
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "connected" } }));
    await vi.waitFor(() =>
      expect(sheet()).toHaveTextContent("app.bp.example.dev couldn’t be reached, so it may still list this Mac. Remove it from your devices there."),
    );
  });

  it("explains a declined code and offers a new one", async () => {
    const { daemon } = await openSwitch();
    await continueTo(NEW_SERVER);
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "denied" } }));
    expect(within(sheet()).getByRole("alert")).toHaveTextContent("The request was declined in Backplane");
    expect(sheet()).toHaveTextContent("still connected to app.bp.example.dev");
    expect(within(sheet()).getByRole("button", { name: "Start again" })).toBeInTheDocument();
  });

  it("explains an unreachable new server and keeps the address", async () => {
    await openSwitch(baseStatus, {
      pair_start: () => {
        throw apiError("server_unreachable");
      },
    });
    await continueTo(NEW_SERVER);
    expect(within(sheet()).getByRole("alert")).toHaveTextContent("Can’t reach intern.example.dev");
    expect(within(sheet()).getByRole("textbox", { name: "Server address" })).toHaveValue(NEW_SERVER);
  });
});

describe("Settings: Switch server, once approved", () => {
  const NEW_SERVER = "https://intern.example.dev";
  const ticket = () => ({
    pairing_id: "pair-switch",
    user_code: "KMTR-XQBW",
    verification_uri: "https://intern.example.dev/companion/pair",
    verification_uri_complete: "https://intern.example.dev/companion/pair#code=KMTR-XQBW",
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    interval: 5,
    endpoint: null,
  });
  const sheet = () => screen.getByRole("dialog", { name: "Switch server" });

  async function approvedSwitch(overrides: Handlers = {}, status: Status = baseStatus) {
    const rendered = await renderSettings(status, {
      pair_start: () => ticket(),
      pair_poll: () => ({ state: "pending" }),
      pair_cancel: () => ({ cancelled: true }),
      ...overrides,
    });
    await userEvent.click(screen.getByRole("button", { name: "Switch server…" }));
    await userEvent.type(within(sheet()).getByRole("textbox", { name: "Server address" }), NEW_SERVER);
    await userEvent.click(within(sheet()).getByRole("button", { name: "Continue" }));
    return rendered;
  }

  it("refuses the current server's web address, not only its API address", async () => {
    const { invoked } = await renderSettings(baseStatus, { pair_start: () => ticket() });
    await userEvent.click(screen.getByRole("button", { name: "Switch server…" }));
    await userEvent.type(within(sheet()).getByRole("textbox", { name: "Server address" }), "https://app.bp.example.dev");
    await userEvent.click(within(sheet()).getByRole("button", { name: "Continue" }));
    expect(sheet()).toHaveTextContent("This Mac is already connected to app.bp.example.dev.");
    expect(invoked("pair_start")).toEqual([]);
  });

  it("counts hook events not yet processed among the waiting uploads", async () => {
    await approvedSwitch({}, { ...baseStatus, queue: { ...baseStatus.queue, records: 4, inbox_items: 2 } });
    expect(sheet()).toHaveTextContent("up to 6 waiting uploads are sent to app.bp.example.dev first");
  });

  it("shows the switch finishing, without Cancel or an expiry, once the code is approved", async () => {
    const { daemon } = await approvedSwitch();
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "persisting" } }));
    expect(sheet()).toHaveTextContent("Switching to intern.example.dev. Sending up to 4 waiting uploads to app.bp.example.dev first.");
    expect(within(sheet()).queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(within(sheet()).queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByText("This code expired")).toBeNull();
    expect(screen.queryByText(/Expires in|expires in/)).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(sheet()).toBeInTheDocument();
  });

  it("keeps the sheet open when a cancel arrives after approval, and ends on Done", async () => {
    const { daemon, invoked } = await approvedSwitch({
      pair_cancel: () => {
        throw apiError("pairing_persisting", 409);
      },
      pair_poll: () => ({ state: "connected", installation_id: "inst-2", old_server_revoked: true }),
    });
    await userEvent.click(within(sheet()).getByRole("button", { name: "Cancel" }));
    expect(invoked("pair_cancel")).toEqual([{ pairingId: "pair-switch" }]);
    expect(sheet()).toHaveTextContent("Switching to intern.example.dev.");
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "connected" } }));
    await vi.waitFor(() => expect(sheet()).toHaveTextContent("Now connected to intern.example.dev. Signed out of app.bp.example.dev."));
  });

  it("stays neutral when an approved switch can't be confirmed, e.g. after a daemon restart", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { daemon } = await approvedSwitch({
        pair_poll: () => {
          throw apiError("not_found", 404);
        },
      });
      act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "persisting" } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(within(sheet()).getByRole("status")).toHaveTextContent("Couldn’t confirm the switch");
      expect(sheet()).toHaveTextContent("Connected to in Settings shows which Backplane this Mac is on now.");
      expect(sheet()).not.toHaveTextContent("Nothing changed");
      expect(sheet()).not.toHaveTextContent("still connected to");
      expect(within(sheet()).queryByRole("button", { name: "Get a new code" })).toBeNull();
      await userEvent.click(within(sheet()).getByRole("button", { name: "Done" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays neutral when an approved switch reports failed", async () => {
    const { daemon } = await approvedSwitch();
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "persisting" } }));
    act(() => daemon.emit({ type: "pairing", data: { pairing_id: "pair-switch", state: "failed" } }));
    expect(sheet()).toHaveTextContent("Couldn’t confirm the switch");
    expect(sheet()).not.toHaveTextContent("Nothing changed");
  });

  it("treats a persisting poll answer as switching", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await approvedSwitch({ pair_poll: () => ({ state: "persisting" }) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(sheet()).toHaveTextContent("Switching to intern.example.dev.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Settings: Sign out copy", () => {
  it("states the waiting-upload count in the sign-out confirmation", async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Sign out…" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("4 uploads haven’t been sent yet and will be deleted.");
  });
});

describe("Settings: Remove Companion", () => {
  const uninstalled = () => ({ uninstalled: true, server_revoked: true });
  const stepFailed = (step: string) => ({ kind: "companion_failed", step, exit_code: 1, message: "raw companion stderr /home/tester" });
  const removedHeading = () => screen.queryByRole("heading", { name: "Backplane Companion was removed from this Mac" });
  const incompleteHeading = () => screen.queryByRole("heading", { name: "Removal may not have finished" });

  async function confirmRemoval() {
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
  }

  it("describes full removal in the row, as the mockup does", async () => {
    await renderSettings();
    expect(row("Remove Companion")).toHaveTextContent("Disconnects, removes every agent hook, and deletes local data.");
  });

  it("lists what goes away and what stays", async () => {
    await renderSettings();
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove Companion?" });
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Disconnect this Mac",
      "Remove the hooks from Claude Code, Codex and Pi",
      "Stop the background service and delete local data",
      "Stop opening at login",
    ]);
    expect(dialog).toHaveTextContent("Sessions already uploaded stay in Backplane.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("removes everything with one companion_uninstall and ends on the removed panel", async () => {
    const { calls } = await renderSettings(baseStatus, { companion_uninstall: uninstalled });
    await confirmRemoval();
    expect(calls.map(([name]) => name).filter((name) => ["companion_uninstall", "disconnect", "agent_uninstall"].includes(name))).toEqual(["companion_uninstall"]);
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removedHeading()).toBeInTheDocument();
    expect(screen.getByText("Quit, then move the app to the Trash. Sessions already uploaded stay in Backplane.")).toBeInTheDocument();
    expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Quit"]);
  });

  it("keeps the dialog through the daemon going away mid-removal, starts no service, and ends on the removed panel", async () => {
    const removal = deferred<ReturnType<typeof uninstalled>>();
    const { daemon, invoked } = await renderSettings(baseStatus, {
      companion_uninstall: () => removal.promise,
      app_location: () => ({ in_applications: true, path: "/Applications/Backplane Companion.app" }),
      start_companion_service: () => ({}),
    });
    await confirmRemoval();
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
    await act(async () => {});
    expect(screen.getByRole("alertdialog", { name: "Remove Companion?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Companion isn't running")).not.toBeInTheDocument();
    await act(async () => removal.resolve(uninstalled()));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(removedHeading()).toBeInTheDocument();
    expect(invoked("start_companion_service")).toEqual([]);
    expect(invoked("app_location")).toEqual([]);
  });

  it("never claims nothing is waiting once the daemon is gone mid-removal", async () => {
    const removal = deferred<ReturnType<typeof uninstalled>>();
    const { daemon } = await renderSettings({ ...baseStatus, queue: { ...baseStatus.queue, records: 3 } }, { companion_uninstall: () => removal.promise });
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Remove Companion?" });
    expect(dialog).toHaveTextContent("3 uploads haven’t been sent yet and will be deleted.");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } }));
    await act(async () => {});
    expect(dialog).not.toHaveTextContent("Nothing is waiting to upload.");
    await act(async () => removal.resolve(uninstalled()));
  });

  it("quits from the removed panel", async () => {
    const { invoked } = await renderSettings(baseStatus, { companion_uninstall: uninstalled, quit_app: () => null });
    await confirmRemoval();
    await vi.waitFor(() => expect(removedHeading()).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Quit" }));
    expect(invoked("quit_app")).toHaveLength(1);
  });

  it("says on the removed panel when Backplane couldn't be told", async () => {
    await renderSettings(baseStatus, { companion_uninstall: () => ({ uninstalled: true, server_revoked: false }) });
    await confirmRemoval();
    await vi.waitFor(() => expect(removedHeading()).toBeInTheDocument());
    expect(screen.getByText("Backplane couldn’t be reached, so remove this Mac from your devices there too.")).toBeInTheDocument();
  });

  it.each([
    ["agents uninstall", "Companion couldn’t remove every agent hook, so removal stopped there. Try again."],
    ["service uninstall", "The agent hooks were removed, but the background service couldn’t be stopped. Try again."],
    ["uninstall --purge", "The agent hooks and the background service were removed, but disconnecting and deleting local data may not have finished. Try again."],
  ])("says what the failed '%s' step means, without the companion's text", async (step, sentence) => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw stepFailed(step);
      },
    });
    await confirmRemoval();
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent(sentence);
    expect(alert).not.toHaveTextContent("raw companion stderr");
  });

  it.each([
    ["a protocol failure", { kind: "protocol", step: "uninstall --purge", message: "expected value at line 1" }],
    ["a step-less failure", { kind: "companion_failed", exit_code: null, message: "spawn failed" }],
    ["an unknown rejection", "command companion_uninstall failed"],
  ])("claims nothing it didn't check after %s", async (_label, rejection) => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw rejection;
      },
    });
    await confirmRemoval();
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent("We couldn’t confirm what finished. Try again.");
  });

  const LOGIN_ITEM_SENTENCE = "Everything else was removed, but Backplane Companion is still set to open at login. Try again.";
  const SERVER_UNREACHED_SENTENCE = "Backplane couldn’t be reached, so remove this Mac from your devices there too.";
  const loginItemFailed = (serverRevoked: boolean) => ({
    kind: "login_item_failed",
    message: "Operation not permitted",
    report: { uninstalled: true, server_revoked: serverRevoked },
  });

  it("says launch at login is still on, and that Backplane couldn't be told, in the dialog and on the panel", async () => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw loginItemFailed(false);
      },
    });
    await confirmRemoval();
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent(LOGIN_ITEM_SENTENCE);
    expect(alert).toHaveTextContent(SERVER_UNREACHED_SENTENCE);
    expect(alert).not.toHaveTextContent("Operation not permitted");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(incompleteHeading()).toBeInTheDocument());
    const panel = within(screen.getByTestId("removal-panel"));
    expect(panel.getByText(LOGIN_ITEM_SENTENCE)).toBeInTheDocument();
    expect(panel.getByText(SERVER_UNREACHED_SENTENCE)).toBeInTheDocument();
  });

  it("says only that launch at login is still on when Backplane was told", async () => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw loginItemFailed(true);
      },
    });
    await confirmRemoval();
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent(LOGIN_ITEM_SENTENCE);
    expect(alert).not.toHaveTextContent(SERVER_UNREACHED_SENTENCE);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(incompleteHeading()).toBeInTheDocument());
    const panel = within(screen.getByTestId("removal-panel"));
    expect(panel.getByText(LOGIN_ITEM_SENTENCE)).toBeInTheDocument();
    expect(panel.queryByText(SERVER_UNREACHED_SENTENCE)).toBeNull();
  });

  it("asks to move the app into Applications first, having removed nothing", async () => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw { kind: "not_in_applications", path: "/home/tester/Downloads/Backplane Companion.app" };
      },
    });
    await confirmRemoval();
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent("Move Backplane Companion to Applications, then try again. Nothing was removed.");
    expect(alert).not.toHaveTextContent("/home/tester");
  });

  it("asks for a reinstall when the app's companion is missing", async () => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw { kind: "not_bundled", path: "/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion" };
      },
    });
    await confirmRemoval();
    const alert = await within(screen.getByRole("alertdialog")).findByRole("alert");
    expect(alert).toHaveTextContent("This copy of the app is incomplete. Reinstall Backplane Companion.");
  });

  it("stays in Settings when Remove is cancelled after a refusal that ran nothing", async () => {
    await renderSettings(baseStatus, {
      companion_uninstall: () => {
        throw { kind: "not_in_applications", path: "/home/tester/Downloads/Backplane Companion.app" };
      },
    });
    await confirmRemoval();
    await within(screen.getByRole("alertdialog")).findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(row("Remove Companion")).toBeInTheDocument();
    expect(incompleteHeading()).toBeNull();
  });

  it.each([["uninstall --purge"], ["service uninstall"], ["agents uninstall"]])(
    "never returns to stale Settings when Remove is cancelled after the '%s' step failed",
    async (step) => {
      await renderSettings(baseStatus, {
        companion_uninstall: () => {
          throw stepFailed(step);
        },
      });
      await confirmRemoval();
      await within(screen.getByRole("alertdialog")).findByRole("alert");
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(incompleteHeading()).toBeInTheDocument();
      expect(screen.queryByText("Remove Companion")).toBeNull();
      expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
    },
  );

  it("offers Try again and Quit on the incomplete panel, never a service start", async () => {
    let attempts = 0;
    const { invoked } = await renderSettings(baseStatus, {
      companion_uninstall: () => {
        attempts += 1;
        if (attempts === 1) throw stepFailed("uninstall --purge");
        return uninstalled();
      },
      quit_app: () => null,
    });
    await confirmRemoval();
    await within(screen.getByRole("alertdialog")).findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(incompleteHeading()).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Try again", "Quit"]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await vi.waitFor(() => expect(removedHeading()).toBeInTheDocument());
    expect(invoked("companion_uninstall")).toHaveLength(2);
    expect(invoked("start_companion_service")).toEqual([]);
  });

  it("finishes on retry from the dialog after a partial failure", async () => {
    let attempts = 0;
    const { invoked } = await renderSettings(baseStatus, {
      companion_uninstall: () => {
        attempts += 1;
        if (attempts === 1) throw stepFailed("service uninstall");
        return uninstalled();
      },
    });
    await confirmRemoval();
    await within(screen.getByRole("alertdialog")).findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(invoked("companion_uninstall")).toHaveLength(2);
    expect(removedHeading()).toBeInTheDocument();
  });

  it("stays put when Remove is cancelled before anything ran", async () => {
    const { invoked } = await renderSettings(baseStatus, { companion_uninstall: uninstalled });
    await userEvent.click(screen.getByRole("button", { name: "Remove…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(invoked("companion_uninstall")).toEqual([]);
    expect(screen.queryByTestId("screen-onboarding")).not.toBeInTheDocument();
    expect(toast()).toBeNull();
  });
});
