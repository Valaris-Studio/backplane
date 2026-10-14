// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render } from "@testing-library/react";

import { App } from "../../App";
import type { AgentEntry, BoardsOverview, CompanionStatus_Deserialize, PairingTicket, ProjectsOverview } from "../../ipc/bindings";
import { startOnboarding } from "../../shell/navigation";
import { startDaemonStream } from "../../stores/daemon-stream";
import { fixtureStatus, mockDaemonIpc } from "../../test/daemon-ipc";

type Status = CompanionStatus_Deserialize;
export type Handlers = NonNullable<Parameters<typeof mockDaemonIpc>[0]>;

export const connectedStatus = fixtureStatus as Status;

export const disconnectedStatus: Status = {
  ...connectedStatus,
  connected: false,
  account: null,
  capture: { ...connectedStatus.capture, state: "not_connected" },
};

export const TICKET: PairingTicket = {
  pairing_id: "pair-1",
  user_code: "KMTR-XQBW",
  verification_uri: "https://app.backplane.example.dev/companion/pair",
  verification_uri_complete: "https://app.backplane.example.dev/companion/pair#code=KMTR-XQBW",
  expires_at: "2026-09-28T10:10:00Z",
  interval: 5,
  endpoint: null,
};

// Any server the user typed: release builds suggest none (owner decision Q2).
export const SERVER_URL = "https://backplane.example.dev";

export const NOW = new Date("2026-09-28T10:00:00Z");

export function apiError(status: number, code: string, message = code) {
  return { kind: "api", status, code, message, detail: null };
}

export const DAEMON_DOWN = { kind: "unreachable", reason: "control_file_missing" };

export const AGENTS: AgentEntry[] = [
  {
    id: "claude_code",
    presence: { installed: true, version: "2.1.0", config_path: "/home/tester/.claude" },
    integration: { state: "installed", config_path: "/home/tester/.claude/settings.json", trust: null },
    action: null,
    telemetry: null,
  },
  {
    id: "codex_cli",
    presence: { installed: true, version: "0.144.1", config_path: "/home/tester/.codex" },
    integration: { state: "not_installed", config_path: "/home/tester/.codex/config.toml", trust: null },
    action: null,
    telemetry: null,
  },
  {
    id: "pi_cli",
    presence: { installed: false, version: null, config_path: "/home/tester/.pi" },
    integration: { state: "not_installed", config_path: "/home/tester/.pi/settings.json", trust: null },
    action: null,
    telemetry: null,
  },
];

export function codexNeedingTrust(): AgentEntry[] {
  return AGENTS.map((agent) =>
    agent.id === "codex_cli" && agent.integration
      ? { ...agent, integration: { ...agent.integration, state: "needs_trust", trust: "needs_trust" } }
      : agent,
  );
}

/** Codex after its hooks were installed while the Codex app (or its background server) was already running. */
export function codexNeedingRestart(problem = "restart_required", trusted = false): AgentEntry[] {
  return AGENTS.map((agent) =>
    agent.id === "codex_cli" && agent.integration
      ? {
          ...agent,
          integration: { ...agent.integration, state: trusted ? "installed" : "needs_trust", trust: trusted ? "trusted" : "needs_trust", problems: [problem] },
        }
      : agent,
  );
}

export const PROJECTS: ProjectsOverview = {
  mappings: [],
  discovered: [
    {
      root: "/home/tester/code/backplane",
      repo_url: "github.com/valaris/backplane",
      first_seen: "2026-09-27T12:00:00Z",
      reason: "auto_match_off",
      candidates: [{ workspace_id: "ws-1", workspace_name: "Valaris", board_id: "b-1", board_name: "Backplane" }],
    },
    { root: "/home/tester/dotfiles", repo_url: null, first_seen: "2026-09-27T12:00:00Z", reason: "no_origin", candidates: [] },
    { root: "/home/tester/code/private", repo_url: "github.com/tester/private", first_seen: "2026-09-27T12:00:00Z", reason: "excluded", candidates: [] },
  ],
  ignored: [],
};

export const BOARDS: BoardsOverview = {
  workspaces: [
    {
      id: "ws-1",
      slug: "valaris",
      name: "Valaris",
      boards: [
        { id: "b-1", name: "Backplane", repos: ["github.com/valaris/backplane"] },
        { id: "b-2", name: "Website", repos: [] },
      ],
    },
    { id: "ws-2", slug: "acme", name: "Acme", boards: [{ id: "b-3", name: "Storefront", repos: ["github.com/acme/storefront-api"] }] },
  ],
};

/** Renders the whole app on a daemon stream that has sent one status. */
export async function renderApp(status: Status, handlers: Handlers = {}, options: { onboarding?: boolean } = {}) {
  const daemon = mockDaemonIpc(handlers);
  if (options.onboarding) startOnboarding();
  startDaemonStream();
  const view = render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
  });
  await act(async () => {});
  return { daemon, ...view };
}

/** Rust's display_path, faked: the test HOME shows as `~`. */
export const maskHome = ({ path }: Record<string, unknown>) => String(path).replace(/^\/home\/tester(?=\/|$)/, "~");

/** Onboarding opened on a device that is already connected (after pairing, or resumed). */
export function renderSetup(handlers: Handlers = {}, status: Status = connectedStatus) {
  return renderApp(status, { agents: () => AGENTS, projects: () => PROJECTS, boards: () => BOARDS, display_path: maskHome, ...handlers }, { onboarding: true });
}
