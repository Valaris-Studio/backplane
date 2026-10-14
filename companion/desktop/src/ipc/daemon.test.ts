// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { commands } from "./bindings";
import { callDaemon } from "./daemon";

describe("callDaemon", () => {
  it("resolves the command value", async () => {
    mockDaemonIpc({ status: () => fixtureStatus });
    await expect(callDaemon(() => commands.status())).resolves.toEqual({ ok: true, value: fixtureStatus });
  });

  it("returns a typed error when the command rejects with a daemon error", async () => {
    mockDaemonIpc({
      pause: () => {
        throw { kind: "api", status: 409, code: "not_connected", message: "Not connected", detail: null };
      },
    });
    await expect(callDaemon(() => commands.pause())).resolves.toEqual({
      ok: false,
      error: { kind: "api", status: 409, code: "not_connected", message: "Not connected", detail: null },
    });
  });

  it("returns an ipc error when the IPC layer refuses the command", async () => {
    mockDaemonIpc();
    const result = await callDaemon(() => commands.version());
    expect(result).toEqual({ ok: false, error: { kind: "ipc", message: "unexpected command version" } });
  });
});
