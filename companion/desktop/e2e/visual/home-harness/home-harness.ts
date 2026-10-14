// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only page for the Home baselines: plays one DK-0 Home scenario
// through a mocked Tauri IPC, then boots the real app entry. The spec fixes
// the page clock at HOME_HARNESS_NOW so elapsed times are stable.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { CompanionStatus_Deserialize, DaemonStreamMessage, LocalSession } from "../../../src/ipc/bindings";
import statusFixture from "../../../src-tauri/tests/fixtures/status.json";
import "../../harness/backdrop.css";
import { HOME_HARNESS_NOW, HOME_SCENARIOS, type HomeScenario } from "./scenarios";
import { MACOS_PLATFORM } from "../../harness/macos-platform";

const requested = new URLSearchParams(location.search).get("scenario");
const scenario: HomeScenario = HOME_SCENARIOS.find((name) => name === requested) ?? "capturing";

const MINUTE_MS = 60_000;
const now = HOME_HARNESS_NOW.getTime();
const capturing = statusFixture as unknown as CompanionStatus_Deserialize;
const withCapture = (state: string, patch: Partial<CompanionStatus_Deserialize> = {}): CompanionStatus_Deserialize => ({
  ...capturing,
  ...patch,
  capture: { ...capturing.capture, state },
});

type Tokens = NonNullable<LocalSession["tokens"]>;
function session(id: string, harness: string, repo: string, startedMsAgo: number, tokens: Tokens, cost: number, basis: "api_equivalent" | "spend"): LocalSession {
  return {
    native_session_id: id,
    harness,
    repo,
    mapping_id: null,
    started_at: new Date(now - startedMsAgo).toISOString(),
    last_event_at: new Date(now - 1_000).toISOString(),
    tokens,
    cost_estimated_usd: cost,
    cost_basis: basis,
    auth_kind: basis === "spend" ? "api" : "subscription",
    history_deleted: null,
  };
}

const live = [
  session("s2", "codex_cli", "github.com/acme/storefront-api", 3 * MINUTE_MS + 40_000, { input: 12_400, output: 6_120, cache_read: 22_000, cache_write: 0 }, 0.38, "spend"),
  session("s1", "claude_code", "github.com/valaris/backplane", 14 * MINUTE_MS + 12_000, { input: 38_210, output: 21_904, cache_read: 118_600, cache_write: 3_720 }, 1.84, "api_equivalent"),
];
const earlier = [
  session("e3", "pi_cli", "github.com/acme/storefront-api", 8 * MINUTE_MS, { input: 9_000, output: 4_100, cache_read: 9_000, cache_write: 0 }, 0.21, "spend"),
  session("e2", "codex_cli", "github.com/valaris/backplane", 18 * MINUTE_MS, { input: 40_000, output: 22_000, cache_read: 68_000, cache_write: 0 }, 1.02, "spend"),
  session("e1", "claude_code", "github.com/valaris/backplane", 42 * MINUTE_MS, { input: 120_000, output: 64_000, cache_read: 420_000, cache_write: 8_000 }, 5.1, "api_equivalent"),
];

// The owner's QA figures: a Claude session re-cached after a pause, and a Codex app session with no usage yet.
const usageLive = [
  { ...session("u2", "codex_desktop", "github.com/acme/storefront-api", 40_000, { input: 0, output: 0, cache_read: 0, cache_write: 0 }, 0, "spend"), tokens: null, cost_estimated_usd: null, cost_basis: null },
  session("u1", "claude_code", "github.com/valaris/backplane", 52 * MINUTE_MS, { input: 2, output: 128, cache_read: 25_300, cache_write: 257_000 }, 11.27, "api_equivalent"),
];

// A busy day (DK-13): enough sessions for the sort/filter toolbar, three agents for the solo tiles.
const busyLive = [
  session("b3", "pi_cli", "github.com/valaris/backplane", 52_000, { input: 3_100, output: 1_400, cache_read: 1_600, cache_write: 0 }, 0.04, "spend"),
  ...live,
];
const busyEarlier = [
  session("b9", "claude_code", "github.com/acme/storefront-api", 31 * MINUTE_MS, { input: 90_000, output: 40_000, cache_read: 270_000, cache_write: 10_000 }, 3.12, "api_equivalent"),
  session("b8", "codex_cli", "github.com/valaris/docs-site", 6 * MINUTE_MS, { input: 5_000, output: 2_400, cache_read: 5_000, cache_write: 0 }, 0.09, "spend"),
  session("b7", "claude_code", "github.com/acme/mobile-app", 25 * MINUTE_MS, { input: 70_000, output: 31_000, cache_read: 195_000, cache_write: 5_000 }, 2.34, "api_equivalent"),
  ...earlier,
];

const endedThenLive = (endedSessions: LocalSession[], liveSessions: LocalSession[]): DaemonStreamMessage[] => [
  ...endedSessions.flatMap((ended): DaemonStreamMessage[] => [
    { type: "session", data: { kind: "started", session: ended } },
    { type: "session", data: { kind: "ended", session: ended } },
  ]),
  ...liveSessions.map((running): DaemonStreamMessage => ({ type: "session", data: { kind: "started", session: running } })),
];

const sessionMessages: DaemonStreamMessage[] = [
  ...earlier.flatMap((ended): DaemonStreamMessage[] => [
    { type: "session", data: { kind: "started", session: ended } },
    { type: "session", data: { kind: "ended", session: ended } },
  ]),
  ...live.map((running): DaemonStreamMessage => ({ type: "session", data: { kind: "started", session: running } })),
];

const statusFor: Record<HomeScenario, CompanionStatus_Deserialize> = {
  capturing,
  attention: { ...capturing, agents: capturing.agents.map((agent) => (agent.id === "codex_cli" ? { ...agent, state: "needs_trust", receiving: false } : agent)) },
  paused: withCapture("paused_locally", { agents: capturing.agents.map((agent) => ({ ...agent, receiving: false })) }),
  "paused-server": withCapture("paused_by_server"),
  offline: withCapture("policy_stale", { queue: { ...capturing.queue, records: 14, backing_off: true } }),
  revoked: withCapture("revoked", { revoked: true }),
  empty: capturing,
  usage: capturing,
  busy: capturing,
};

const scenarioSessions: DaemonStreamMessage[] =
  scenario === "empty"
    ? []
    : scenario === "usage"
      ? usageLive.map((running): DaemonStreamMessage => ({ type: "session", data: { kind: "started", session: running } }))
      : scenario === "busy"
        ? endedThenLive(busyEarlier, busyLive)
        : sessionMessages;

const script: DaemonStreamMessage[] = [
  { type: "daemon.connected" },
  { type: "status", data: statusFor[scenario] },
  ...scenarioSessions,
];

const boards = {
  workspaces: [
    {
      id: "w1",
      slug: "internal",
      name: "Internal projects",
      boards: [
        { id: "b-backplane", name: "Backplane", repos: ["github.com/valaris/backplane"] },
        { id: "b-docs", name: "Docs", repos: ["github.com/valaris/docs-site"] },
      ],
    },
    {
      id: "w2",
      slug: "acme",
      name: "Acme",
      boards: [
        { id: "b-storefront", name: "Storefront", repos: ["github.com/acme/storefront-api"] },
        { id: "b-mobile", name: "Mobile app", repos: ["github.com/acme/mobile-app"] },
      ],
    },
  ],
};

interface TauriInternals {
  runCallback: (id: number, data: unknown) => void;
}

mockIPC((command, payload) => {
  switch (command) {
    case "platform_info":
      return MACOS_PLATFORM;
    case "boards":
      return boards;
    case "projects":
      return { mappings: [], discovered: [], ignored: [] };
    case "pause":
      return { paused: true };
    case "resume":
      return { paused: false };
    case "open_backplane_url":
      return null;
    case "subscribe_events": {
      const channel = (payload as { onEvent: Channel<DaemonStreamMessage> }).onEvent;
      const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
      queueMicrotask(() => {
        script.forEach((message, index) => internals.runCallback(channel.id, { index, message }));
      });
      return null;
    }
    default:
      throw `home harness: unmocked command ${command}`;
  }
});

await import("../../../src/main");
