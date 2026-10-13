// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only page for the Agents baselines: plays one DK-0 Agents
// scenario through a mocked Tauri IPC, then boots the real app entry. The spec
// fixes the page clock at AGENTS_HARNESS_NOW so relative times are stable.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { DaemonStreamMessage, LocalSession } from "../../../src/ipc/bindings";
import { AGENTS_NOW, AGENTS_SCENARIOS, entryFor } from "../../../src/screens/agents/agents-fixtures";
import "../../harness/backdrop.css";
import { AGENTS_HARNESS_NOW, AGENTS_HARNESS_SCENARIOS, type AgentsHarnessScenario } from "./scenarios";
import { MACOS_PLATFORM } from "../../harness/macos-platform";

if (AGENTS_NOW.getTime() !== AGENTS_HARNESS_NOW.getTime()) throw new Error("agents harness: fixture and harness clocks disagree");

const requested = new URLSearchParams(location.search).get("scenario");
const scenario: AgentsHarnessScenario = AGENTS_HARNESS_SCENARIOS.find((name) => name === requested) ?? "healthy";

const liveClaudeSession: LocalSession = {
  native_session_id: "s1",
  harness: "claude_code",
  repo: "github.com/valaris/backplane",
  mapping_id: null,
  started_at: new Date(AGENTS_NOW.getTime() - 14 * 60_000).toISOString(),
  last_event_at: new Date(AGENTS_NOW.getTime() - 1_000).toISOString(),
  tokens: null,
  cost_estimated_usd: null,
  cost_basis: null,
  auth_kind: null,
  history_deleted: null,
};

function attentionFor(code: string): DaemonStreamMessage {
  return { type: "attention", data: { items: [{ code, severity: "warning", agent: "codex_cli", message: "" }] } };
}

const script: DaemonStreamMessage[] = [
  { type: "daemon.connected" },
  { type: "status", data: AGENTS_SCENARIOS[scenario] },
  ...(scenario === "healthy" ? [{ type: "session", data: { kind: "started", session: liveClaudeSession } } as const] : []),
  // DK-12f: the daemon names the stale Codex app in attention too, so the header asks for it.
  ...(scenario === "restart" || scenario === "daemonRestart"
    ? [attentionFor(scenario === "restart" ? "restart_required" : "daemon_restart_required")]
    : []),
];

interface TauriInternals {
  runCallback: (id: number, data: unknown) => void;
}

mockIPC((command, payload) => {
  switch (command) {
    case "platform_info":
      return MACOS_PLATFORM;
    case "subscribe_events": {
      const channel = (payload as { onEvent: Channel<DaemonStreamMessage> }).onEvent;
      const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      queueMicrotask(() => {
        script.forEach((message, index) => internals.runCallback(channel.id, { index, message }));
      });
      return null;
    }
    case "agents":
      return AGENTS_SCENARIOS[scenario].agents.map((agent) => entryFor(agent));
    case "boards":
      return { workspaces: [] };
    case "projects":
      return { mappings: [], discovered: [], ignored: [] };
    case "display_path":
      return (payload as { path: string }).path.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
    default:
      throw `agents harness: unmocked command ${command}`;
  }
});

await import("../../../src/main");
