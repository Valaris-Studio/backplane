// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { AttentionItem, CompanionStatus_Deserialize } from "../ipc/bindings";
import { fixtureStatus } from "../test/daemon-ipc";
import { agentsNeedingAttention, statusModel, type StatusModel } from "./status-model";

type Status = CompanionStatus_Deserialize;
const base = fixtureStatus as Status;

function withCapture(state: string, patch: Partial<Status> = {}): Status {
  return { ...base, ...patch, capture: { ...base.capture, state } };
}

function withAgentState(agentState: string): Status {
  return { ...base, agents: base.agents.map((agent, index) => (index === 1 ? { ...agent, state: agentState } : agent)) };
}

const offline: Status = { ...base, queue: { ...base.queue, backing_off: true } };
const needsTrust: AttentionItem = { code: "needs_trust", severity: "warning", agent: "codex_cli", message: "Codex needs approval" };

type Row = [name: string, input: Parameters<typeof statusModel>[0], expected: Partial<StatusModel>];

const TABLE: Row[] = [
  [
    "active, capturing with receiving agents",
    { status: base, attention: [] },
    { tone: "success", glyph: { kind: "tray", state: "capturing" }, title: "Capturing", sub: "Receiving from Claude Code", pauseControl: "pause", showTabs: true, trayState: "capturing" },
  ],
  [
    "active, counting live sessions and naming the device",
    { status: base, attention: [], liveSessions: 2, deviceName: "Ada’s MacBook Pro" },
    { tone: "success", sub: "2 live sessions · Ada’s MacBook Pro" },
  ],
  [
    "active, one live session",
    { status: base, attention: [], liveSessions: 1 },
    { sub: "1 live session" },
  ],
  [
    "active, nothing running",
    { status: { ...base, agents: base.agents.map((agent) => ({ ...agent, receiving: false })) }, attention: [], liveSessions: 0, deviceName: "Ada’s MacBook Pro" },
    { tone: "success", sub: "Waiting for a session · Ada’s MacBook Pro" },
  ],
  [
    "active, zero counted sessions but an agent receiving",
    { status: base, attention: [], liveSessions: 0 },
    { sub: "Receiving from Claude Code" },
  ],
  [
    "active, no agent receiving and no session count",
    { status: { ...base, agents: base.agents.map((agent) => ({ ...agent, receiving: false })) }, attention: [] },
    { sub: "Waiting for a session" },
  ],
  [
    "active, two agents receiving",
    { status: { ...base, agents: base.agents.map((agent) => ({ ...agent, receiving: true })) }, attention: [] },
    { sub: "Receiving from 2 agents" },
  ],
  [
    "active with an attention item",
    { status: base, attention: [needsTrust] },
    { tone: "warning", glyph: { kind: "icon", name: "alert" }, title: "Capturing", sub: "One agent needs your attention", pauseControl: "pause", trayState: "attention" },
  ],
  [
    "active with an agent in a problem state and no attention item yet",
    { status: withAgentState("broken"), attention: [] },
    { tone: "warning", sub: "One agent needs your attention", trayState: "attention" },
  ],
  [
    "active with two agents needing attention",
    { status: withAgentState("invalid_config"), attention: [{ ...needsTrust, agent: "claude_code" }] },
    { sub: "2 agents need your attention" },
  ],
  [
    "active with an attention item not tied to an agent",
    { status: base, attention: [{ code: "conflict", severity: "warning", agent: null, message: "x" }] },
    { tone: "warning", sub: "Something needs your attention" },
  ],
  [
    "paused_locally",
    { status: withCapture("paused_locally"), attention: [] },
    { tone: "neutral", glyph: { kind: "icon", name: "pause" }, title: "Paused", sub: "Nothing is recorded until you resume", pauseControl: "resume", showTabs: true, trayState: "paused" },
  ],
  [
    "paused_by_server",
    { status: withCapture("paused_by_server"), attention: [] },
    { tone: "neutral", title: "Paused from Backplane", sub: "Resume it from this device’s page in Backplane", pauseControl: "pause-disabled", pauseHint: "Paused from Backplane", trayState: "paused" },
  ],
  [
    "paused wins over attention",
    { status: withCapture("paused_locally"), attention: [needsTrust] },
    { title: "Paused", trayState: "paused" },
  ],
  [
    "offline: uploads backing off",
    { status: offline, attention: [] },
    { tone: "warning", glyph: { kind: "icon", name: "cloud-off" }, title: "Can’t reach Backplane", sub: "Sessions are saved on this Mac for now", pauseControl: "pause", trayState: "offline" },
  ],
  [
    "offline: policy_stale",
    { status: withCapture("policy_stale"), attention: [] },
    { tone: "warning", title: "Can’t reach Backplane", pauseControl: "pause", trayState: "offline" },
  ],
  [
    "offline wins over a local pause, as the tray does, and keeps Resume",
    { status: { ...withCapture("paused_locally"), queue: offline.queue }, attention: [] },
    { title: "Can’t reach Backplane", pauseControl: "resume", trayState: "offline" },
  ],
  [
    "revoked state",
    { status: withCapture("revoked"), attention: [] },
    { tone: "error", glyph: { kind: "icon", name: "power" }, title: "Disconnected", sub: "This Mac needs to connect again", pauseControl: "none", showTabs: false, trayState: "disconnected" },
  ],
  [
    "revoked flag with a stale state string",
    { status: { ...base, revoked: true }, attention: [] },
    { tone: "error", title: "Disconnected", showTabs: false },
  ],
  [
    "not_connected",
    { status: withCapture("not_connected", { connected: false }), attention: [] },
    { tone: "neutral", glyph: { kind: "tray", state: "disconnected" }, title: "Not connected", pauseControl: "none", showTabs: false, trayState: "disconnected" },
  ],
  [
    "an unknown future state",
    { status: withCapture("warming_up"), attention: [] },
    { tone: "neutral", title: "Companion", sub: "Status: warming up", pauseControl: "none", showTabs: true },
  ],
];

describe("statusModel", () => {
  it.each(TABLE)("%s", (_name, input, expected) => {
    expect(statusModel(input)).toMatchObject(expected);
  });

  it("covers every capture.state the daemon reports", () => {
    const covered = new Set(TABLE.map(([, input]) => input.status.capture.state));
    for (const state of ["revoked", "not_connected", "paused_locally", "paused_by_server", "policy_stale", "active"]) {
      expect(covered).toContain(state);
    }
  });
});

describe("agentsNeedingAttention", () => {
  it("unions problem-state agents with attention items that name an agent", () => {
    expect(agentsNeedingAttention(withAgentState("needs_trust"), [{ ...needsTrust, agent: "pi_cli" }])).toEqual(["codex_cli", "pi_cli"]);
  });

  it("is empty when every agent is healthy and nothing names an agent", () => {
    expect(agentsNeedingAttention(base, [{ code: "policy_stale", severity: "warning", agent: null, message: "" }])).toEqual([]);
  });
});
