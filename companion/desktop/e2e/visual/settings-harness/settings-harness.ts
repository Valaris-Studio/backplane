// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only page for the Settings baselines: plays DK-0's Settings data
// through a mocked Tauri IPC, boots the real app entry and pushes Settings.
// The spec drives the Update, Switch server, Sign out and Remove scenarios by clicking.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { CompanionStatus_Deserialize, DaemonStreamMessage } from "../../../src/ipc/bindings";
import statusFixture from "../../../src-tauri/tests/fixtures/status.json";
import "../../harness/backdrop.css";
import { MACOS_PLATFORM } from "../../harness/macos-platform";

const fixture = statusFixture as unknown as CompanionStatus_Deserialize;
const status: CompanionStatus_Deserialize = {
  ...fixture,
  companion: { ...fixture.companion, version: "0.8.2" },
  endpoint: "https://api.backplane.example",
  installation_id: "7c1e2b40-9d3a-4f7e-8c21-5b0e3d6fa94f",
  account: {
    email: "ada@example.com",
    display_name: null,
    web_origin: "https://backplane.example",
    device_name: "Ada’s MacBook Pro",
  } as CompanionStatus_Deserialize["account"],
  capture: { ...fixture.capture, retention_days: 90 },
  queue: { ...fixture.queue, records: Number(new URLSearchParams(location.search).get("waiting") ?? 0), bytes: 0, last_error: null },
};

const params = new URLSearchParams(location.search);
// ?removal=incomplete makes Remove Companion fail at its last step.
const removalFails = params.get("removal") === "incomplete";
// ?switch=approved-offline approves the Switch server code at the first poll, with the old server unreachable;
// ?switch=switching leaves it approved and still connecting.
const switchApproved = params.get("switch") === "approved-offline";
const switchSwitching = params.get("switch") === "switching";
const PAIRING_LIFETIME_MS = 10 * 60_000;

const script: DaemonStreamMessage[] = [{ type: "daemon.connected" }, { type: "status", data: status }];

interface TauriInternals {
  runCallback: (id: number, data: unknown) => void;
}

mockIPC((command, payload) => {
  switch (command) {
    case "platform_info":
      return MACOS_PLATFORM;
    case "launch_at_login_get":
    case "notifications_get":
      return true;
    case "update_channel_get":
      return "stable";
    case "last_update_result":
      return null;
    case "check_for_update":
      return { available: true, version: "0.9.0", notes: null, date: null };
    case "install_update":
      return new Promise(() => {});
    case "boards":
      return { workspaces: [] };
    case "projects":
      return { mappings: [], discovered: [], ignored: [] };
    case "agents":
      return [];
    case "pair_start":
      return {
        pairing_id: "pair-switch",
        user_code: "KMTR-XQBW",
        verification_uri: "https://intern.backplane.example/companion/pair",
        verification_uri_complete: "https://intern.backplane.example/companion/pair#code=KMTR-XQBW",
        expires_at: new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString(),
        interval: 1,
        endpoint: null,
      };
    case "pair_poll":
      if (switchSwitching) return { state: "persisting" };
      return switchApproved ? { state: "connected", installation_id: "inst-2", old_server_revoked: false } : { state: "pending" };
    case "pair_cancel":
      return { cancelled: true };
    case "open_backplane_url":
      return null;
    case "companion_uninstall":
      if (removalFails) throw { kind: "companion_failed", step: "uninstall --purge", exit_code: 1, message: "" };
      return { uninstalled: true, server_revoked: true };
    case "subscribe_events": {
      const channel = (payload as { onEvent: Channel<DaemonStreamMessage> }).onEvent;
      const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      queueMicrotask(() => {
        script.forEach((message, index) => internals.runCallback(channel.id, { index, message }));
      });
      return null;
    }
    default:
      throw `settings harness: unmocked command ${command}`;
  }
});

await import("../../../src/main");
const { push } = await import("../../../src/shell/navigation");
push("settings");
