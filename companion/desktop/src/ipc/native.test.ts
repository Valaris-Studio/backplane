// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { mockDaemonIpc } from "../test/daemon-ipc";
import { toCompanionError } from "./errors";
import {
  hidePopover,
  launchAtLogin,
  notificationsEnabled,
  pickProjectFolder,
  revealAgentConfig,
  saveDiagnostics,
  setLaunchAtLogin,
  setNotificationsEnabled,
} from "./native";

const FOUND = { root: "/home/me/code/app", repo_url: "github.com/acme/app", first_seen: "2026-09-29T09:00:00Z", reason: "not_bound", candidates: [] };

describe("native desktop wrappers", () => {
  it("invoke their Rust commands with only the typed arguments", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const record = (name: string, value: unknown) => (args: Record<string, unknown>) => {
      calls.push([name, args]);
      return value;
    };
    mockDaemonIpc({
      pick_project_folder: record("pick_project_folder", FOUND),
      reveal_agent_config: record("reveal_agent_config", null),
      save_diagnostics: record("save_diagnostics", { saved: true, file_name: "backplane-diagnostics-2026-09-28.zip" }),
      launch_at_login_get: record("launch_at_login_get", false),
      launch_at_login_set: record("launch_at_login_set", true),
      notifications_get: record("notifications_get", true),
      notifications_set: record("notifications_set", false),
    });

    await expect(pickProjectFolder()).resolves.toEqual({ ok: true, value: FOUND });
    await expect(revealAgentConfig("codex_cli")).resolves.toEqual({ ok: true, value: null });
    await expect(saveDiagnostics()).resolves.toEqual({
      ok: true,
      value: { saved: true, file_name: "backplane-diagnostics-2026-09-28.zip" },
    });
    await expect(launchAtLogin()).resolves.toEqual({ ok: true, value: false });
    await expect(setLaunchAtLogin(true)).resolves.toEqual({ ok: true, value: true });
    await expect(notificationsEnabled()).resolves.toEqual({ ok: true, value: true });
    await expect(setNotificationsEnabled(false)).resolves.toEqual({ ok: true, value: false });

    expect(calls.map(([name]) => name)).toEqual([
      "pick_project_folder",
      "reveal_agent_config",
      "save_diagnostics",
      "launch_at_login_get",
      "launch_at_login_set",
      "notifications_get",
      "notifications_set",
    ]);
    expect(calls[0]?.[1]).toEqual({});
    expect(calls[1]?.[1]).toMatchObject({ agentId: "codex_cli" });
    expect(calls[4]?.[1]).toMatchObject({ enabled: true });
    expect(calls[6]?.[1]).toMatchObject({ enabled: false });
  });

  it("returns a cancelled folder pick as null, not an error", async () => {
    mockDaemonIpc({ pick_project_folder: () => null });
    await expect(pickProjectFolder()).resolves.toEqual({ ok: true, value: null });
  });

  it("returns the daemon's refusal of a picked folder as a typed error", async () => {
    mockDaemonIpc({
      pick_project_folder: () => {
        throw { kind: "api", status: 409, code: "ignored_path", message: "ignored", detail: null };
      },
    });
    await expect(pickProjectFolder()).resolves.toMatchObject({ ok: false, error: { kind: "api", code: "ignored_path" } });
  });

  it("returns typed errors instead of throwing", async () => {
    mockDaemonIpc({
      reveal_agent_config: () => {
        throw { kind: "invalid_input", message: "the daemon does not list this agent" };
      },
      save_diagnostics: () => {
        throw { kind: "unreachable", reason: "socket_unavailable" };
      },
    });
    await expect(revealAgentConfig("pi_cli")).resolves.toEqual({
      ok: false,
      error: { kind: "invalid_input", message: "the daemon does not list this agent" },
    });
    await expect(saveDiagnostics()).resolves.toEqual({
      ok: false,
      error: { kind: "unreachable", reason: "socket_unavailable" },
    });
  });

  it("hidePopover swallows a refusal instead of rejecting", async () => {
    const daemon = mockDaemonIpc();
    await expect(hidePopover()).resolves.toBeUndefined();
    expect(daemon.invoked()).toEqual(["hide_popover"]);
  });
});

describe("toCompanionError for native failures", () => {
  it("keeps a local failure's message", () => {
    expect(toCompanionError({ kind: "local", message: "could not write the file" })).toEqual({
      kind: "local",
      message: "could not write the file",
    });
  });

  it("rejects a malformed local failure", () => {
    expect(toCompanionError({ kind: "local" })).toEqual({ kind: "ipc", message: "unrecognised IPC error" });
  });
});
