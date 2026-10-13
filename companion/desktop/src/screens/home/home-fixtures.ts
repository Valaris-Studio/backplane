// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import type { BoardsOverview_Deserialize, CompanionStatus_Deserialize, LocalSession, ProjectsOverview_Deserialize, SessionEvent } from "../../ipc/bindings";
import { fixtureStatus } from "../../test/daemon-ipc";

export type Status = CompanionStatus_Deserialize;

export const NOW = new Date("2026-09-28T12:00:00");
const MINUTE_MS = 60_000;

// The shared fixture still uses short agent ids; the daemon sends harness ids (claude_code, codex_cli).
const DAEMON_AGENT_ID: Record<string, string> = { claude: "claude_code", codex: "codex_cli" };
const fixture = fixtureStatus as Status;
export const baseStatus: Status = { ...fixture, agents: fixture.agents.map((agent) => ({ ...agent, id: DAEMON_AGENT_ID[agent.id] ?? agent.id })) };

export function withCapture(state: string, patch: Partial<Status> = {}): Status {
  return { ...baseStatus, ...patch, capture: { ...baseStatus.capture, state } };
}

export function session(overrides: Partial<LocalSession> & { native_session_id: string }): LocalSession {
  return {
    harness: "claude_code",
    repo: "github.com/acme/app",
    mapping_id: null,
    started_at: new Date(NOW.getTime() - 14 * MINUTE_MS - 12_000).toISOString(),
    last_event_at: new Date(NOW.getTime() - 1_000).toISOString(),
    tokens: { input: 38_210, output: 21_904, cache_read: 118_600, cache_write: 3_720 },
    cost_estimated_usd: 1.84,
    cost_basis: "api_equivalent",
    auth_kind: "subscription",
    history_deleted: null,
    ...overrides,
  };
}

export const claudeSession = session({ native_session_id: "sess-claude" });

export const codexSession = session({
  native_session_id: "sess-codex",
  harness: "codex_cli",
  repo: "github.com/acme/storefront-api",
  started_at: new Date(NOW.getTime() - 3 * MINUTE_MS - 40_000).toISOString(),
  tokens: { input: 12_400, output: 6_120, cache_read: 22_000, cache_write: 0 },
  cost_estimated_usd: 0.38,
  cost_basis: "spend",
  auth_kind: "api",
});

export function sessionEvent(kind: "started" | "updated" | "ended", payload: LocalSession): SessionEvent {
  return { kind, session: payload };
}

export const boards: BoardsOverview_Deserialize = {
  workspaces: [
    {
      id: "w1",
      slug: "internal",
      name: "Internal projects",
      boards: [
        { id: "b-backplane", name: "Backplane", repos: ["github.com/acme/app"] },
        { id: "b-mobile", name: "Mobile app", repos: ["github.com/acme/mobile-app"] },
        { id: "b-mobile-qa", name: "Mobile app QA", repos: ["github.com/acme/mobile-app"] },
      ],
    },
    {
      id: "w2",
      slug: "acme",
      name: "Acme",
      boards: [
        { id: "b-storefront", name: "Storefront", repos: [] },
        { id: "b-skate", name: "Skate", repos: [] },
      ],
    },
  ],
};

// The storefront board lists no repo; only the mapping ties the repo to it.
// m3 binds a folder by path ("Bind folder…"): no repo, only a root and a board.
export const projects: ProjectsOverview_Deserialize = {
  mappings: [
    { id: "m1", workspace_id: "w1", board_id: "b-backplane", repo_url_normalized: "github.com/acme/app", enabled: true, content_level: "standard" },
    { id: "m2", workspace_id: "w2", board_id: "b-storefront", repo_url_normalized: "github.com/acme/storefront-api", enabled: true, content_level: "metadata" },
    { id: "m3", workspace_id: "w2", board_id: "b-skate", root_path: "/home/me/code/skate", enabled: true, content_level: "standard" },
  ],
  discovered: [],
  ignored: [],
};
