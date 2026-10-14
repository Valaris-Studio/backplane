// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only page for the onboarding baselines: a mocked daemon whose
// pairing poll answers per scenario, then the real app entry.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { AgentEntry, CompanionStatus_Deserialize, DaemonStreamMessage, ProjectsOverview } from "../../../src/ipc/bindings";
import statusFixture from "../../../src-tauri/tests/fixtures/status.json";
import "../../harness/backdrop.css";
import { MACOS_PLATFORM } from "../../harness/macos-platform";

const POLL_ANSWERS = {
  pending: () => ({ state: "pending" }),
  connected: () => ({ state: "connected", installation_id: "inst_7f3a" }),
  expired: () => Promise.reject({ kind: "api", status: 410, code: "pairing_expired", message: "The pairing code expired; start again.", detail: null }),
  denied: () => Promise.reject({ kind: "api", status: 403, code: "pairing_denied", message: "The pairing was denied in Backplane.", detail: null }),
  offline: () => Promise.reject({ kind: "api", status: 502, code: "server_unreachable", message: "The server did not answer.", detail: null }),
} as const;

const POLL_FOR_SCENARIO: Record<string, keyof typeof POLL_ANSWERS> = {
  "code-expired": "expired",
  "code-denied": "denied",
  "code-offline": "offline",
  agents: "connected",
  "agents-restart": "connected",
  projects: "connected",
  "projects-no-boards": "connected",
  "projects-empty": "connected",
  done: "connected",
};

const scenario = new URLSearchParams(location.search).get("scenario") ?? "welcome";
const pollAnswer = POLL_ANSWERS[POLL_FOR_SCENARIO[scenario] ?? "pending"];

const connected = statusFixture as unknown as CompanionStatus_Deserialize;
const disconnected: CompanionStatus_Deserialize = {
  ...connected,
  connected: false,
  account: null,
  capture: { ...connected.capture, state: "not_connected" },
  suggested_device_name: scenario === "server-unnamed" ? null : "Tester’s MacBook Pro",
};

const agents: AgentEntry[] = [
  { id: "claude_code", presence: { installed: true, version: "2.1.0", config_path: "/home/tester/.claude" }, integration: { state: "installed", config_path: "", trust: null }, action: null, telemetry: null },
  scenario === "agents-restart"
    ? // DK-12f: hooks just added while the Codex app was already open.
      { id: "codex_cli", presence: { installed: true, version: "0.144.1", config_path: "/home/tester/.codex" }, integration: { state: "needs_trust", config_path: "", trust: "needs_trust", problems: ["restart_required"] }, action: null, telemetry: null }
    : { id: "codex_cli", presence: { installed: true, version: "0.144.1", config_path: "/home/tester/.codex" }, integration: { state: "not_installed", config_path: "", trust: null }, action: null, telemetry: null },
  { id: "pi_cli", presence: { installed: false, version: null, config_path: "" }, integration: { state: "not_installed", config_path: "", trust: null }, action: null, telemetry: null },
];

const projects: ProjectsOverview = {
  mappings: [],
  discovered: [
    { root: "/home/tester/code/valaris/backplane", repo_url: "github.com/valaris/backplane", first_seen: "2026-09-27T12:00:00Z", reason: "auto_match_off", candidates: [{ workspace_id: "ws-1", workspace_name: "Valaris", board_id: "b-1", board_name: "Backplane" }] },
    { root: "/home/tester/code/acme/storefront-api", repo_url: "github.com/acme/storefront-api", first_seen: "2026-09-27T12:00:00Z", reason: "auto_match_off", candidates: [{ workspace_id: "ws-2", workspace_name: "Acme", board_id: "b-3", board_name: "Storefront" }] },
    { root: "/home/tester/dotfiles", repo_url: null, first_seen: "2026-09-27T12:00:00Z", reason: "no_origin", candidates: [] },
  ],
  ignored: [],
};

interface TauriInternals {
  runCallback: (id: number, data: unknown) => void;
}

let channel: Channel<DaemonStreamMessage> | null = null;
let pairStarts = 0;
let nextIndex = 0;
function emit(message: DaemonStreamMessage) {
  if (!channel) return;
  const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
  internals.runCallback(channel.id, { index: nextIndex++, message });
}

mockIPC((command, payload) => {
  switch (command) {
    case "platform_info":
      return MACOS_PLATFORM;
    case "subscribe_events":
      channel = (payload as { onEvent: Channel<DaemonStreamMessage> }).onEvent;
      queueMicrotask(() => {
        emit({ type: "daemon.connected" });
        emit({ type: "status", data: disconnected });
      });
      return null;
    case "pair_start":
      // "slow-start": the first pairing never answers, as with a server that hangs.
      pairStarts += 1;
      if (scenario === "slow-start" && pairStarts === 1) return new Promise(() => {});
      return {
        pairing_id: "pair-1",
        user_code: "KMTR-XQBW",
        verification_uri: "https://app.backplane.example.dev/companion/pair",
        verification_uri_complete: "https://app.backplane.example.dev/companion/pair#code=KMTR-XQBW",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        interval: 1,
      };
    case "pair_poll": {
      const answer = pollAnswer();
      if ("state" in answer && answer.state === "connected") queueMicrotask(() => emit({ type: "status", data: connected }));
      return answer;
    }
    case "pair_cancel":
      return { cancelled: true };
    case "pair_current":
      return null;
    case "display_path":
      return (payload as { path: string }).path.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
    case "agents":
      return agents;
    case "projects":
      return scenario === "projects-empty" ? { ...projects, discovered: [] } : projects;
    case "boards":
      // A fresh instance: the owner can reach no board yet.
      if (scenario === "projects-no-boards") return { workspaces: [] };
      throw `onboarding harness: unmocked command ${command}`;
    default:
      throw `onboarding harness: unmocked command ${command}`;
  }
});

await import("../../../src/main");
