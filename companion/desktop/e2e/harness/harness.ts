// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Dev-server-only page (never part of `vite build`): installs a mocked Tauri
// IPC that plays the shell's daemon stream, then boots the real app entry.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";

import type { CompanionStatus_Deserialize, DaemonStreamMessage } from "../../src/ipc/bindings";
import statusFixture from "../../src-tauri/tests/fixtures/status.json";
import "./backdrop.css";
import { MACOS_PLATFORM } from "./macos-platform";

const SCENARIOS = ["home", "paused", "onboarding", "not-running"] as const;
type Scenario = (typeof SCENARIOS)[number];

const requested = new URLSearchParams(location.search).get("scenario");
const scenario: Scenario = SCENARIOS.find((name) => name === requested) ?? "home";

const capturing = statusFixture as unknown as CompanionStatus_Deserialize;
const withCapture = (state: string, patch: Partial<CompanionStatus_Deserialize> = {}): CompanionStatus_Deserialize => ({
  ...capturing,
  ...patch,
  capture: { ...capturing.capture, state },
});

const scripts: Record<Scenario, DaemonStreamMessage[]> = {
  home: [{ type: "daemon.connected" }, { type: "status", data: capturing }],
  paused: [{ type: "daemon.connected" }, { type: "status", data: withCapture("paused_locally", { agents: capturing.agents.map((agent) => ({ ...agent, receiving: false })) }) }],
  onboarding: [{ type: "daemon.connected" }, { type: "status", data: withCapture("not_connected", { connected: false }) }],
  "not-running": [{ type: "daemon.unreachable", data: { reason: "control_file_missing" } }],
};

interface TauriInternals {
  runCallback: (id: number, data: unknown) => void;
}

mockIPC((command, payload) => {
  if (command === "platform_info") return MACOS_PLATFORM;
  if (command === "pause") return { paused: true };
  if (command === "resume") return { paused: false };
  if (command !== "subscribe_events") throw `harness: unmocked command ${command}`;
  const channel = (payload as { onEvent: Channel<DaemonStreamMessage> }).onEvent;
  const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
  queueMicrotask(() => {
    scripts[scenario].forEach((message, index) => internals.runCallback(channel.id, { index, message }));
  });
  return null;
});

await import("../../src/main");
