// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only page for the Projects baselines: the DK-0 Projects data
// (three bound folders, one found folder per reason, two ignored, two rules)
// through a mocked Tauri IPC, then the real app entry. The spec opens the tab.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { CompanionStatus_Deserialize, DaemonStreamMessage } from "../../../src/ipc/bindings";
import statusFixture from "../../../src-tauri/tests/fixtures/status.json";
import { accessOff, accessOn, boards, overview, withAgents } from "../../../src/screens/projects/projects-fixtures";
import "../../harness/backdrop.css";
import { MACOS_PLATFORM } from "../../harness/macos-platform";

const fixture = statusFixture as unknown as CompanionStatus_Deserialize;
const status: CompanionStatus_Deserialize = {
  ...fixture,
  // No discovered-count badge noise from the shared fixture, and the mockup's rules.
  pending_projects: [],
  capture: { ...fixture.capture, auto_match_repos: false, exclude_globs: ["~/clients/**", "~/personal/**"] },
};

const params = new URLSearchParams(location.search);
// ?no-boards: a fresh instance, where the owner can reach no board yet.
const catalog = params.has("no-boards") ? { workspaces: [] } : boards;
// ?no-found: no agent has run in an unbound folder yet.
const projects = params.has("no-found") ? { ...overview, discovered: [] } : overview;

// ?agents: agents on for backplane. ?agents-blocked: the key was deleted on the web, uv is missing, and Codex has a server named backplane.
const agentsBlocked = withAgents(
  [
    { agent_id: "claude_code", scope: "folder", state: "configured", problem: "uvx_missing" },
    { agent_id: "codex_cli", scope: "global", state: "conflict", problem: null },
    { agent_id: "pi_cli", scope: "global", state: "unsupported", problem: "agent_not_installed" },
  ],
  {
    key: { present: false, key_prefix: null, server_state: "missing" },
    prerequisites: { uvx: false },
    warnings: [{ agent_id: "codex_cli", entry_name: "backplane", reason: "mcp_name_taken" }],
  },
);
const agentAccess = params.has("agents") ? accessOn : params.has("agents-blocked") ? agentsBlocked : accessOff;

const script: DaemonStreamMessage[] = [{ type: "daemon.connected" }, { type: "status", data: status }];

interface TauriInternals {
  runCallback: (id: number, data: unknown) => void;
}

mockIPC((command, payload) => {
  switch (command) {
    case "platform_info":
      return MACOS_PLATFORM;
    case "boards":
      return catalog;
    case "projects":
      return projects;
    case "agent_access_get":
      return agentAccess;
    case "subscribe_events": {
      const channel = (payload as { onEvent: Channel<DaemonStreamMessage> }).onEvent;
      const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      queueMicrotask(() => {
        script.forEach((message, index) => internals.runCallback(channel.id, { index, message }));
      });
      return null;
    }
    case "display_path":
      return (payload as { path: string }).path.replace(/^\/home\/[^/]+(?=\/|$)/, "~");
    default:
      throw `projects harness: unmocked command ${command}`;
  }
});

await import("../../../src/main");
