// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentId } from "../ipc/bindings";
import { fixtureStatus } from "../test/daemon-ipc";
import { AgentTile } from "./AgentTile";
import { agentDisplayName, agentIntegrationId, agentMonogram, isKnownAgent } from "./agent-identity";

const DAEMON_AGENTS: Array<[AgentId, string, string]> = [
  ["claude_code", "Claude Code", "CC"],
  ["codex_cli", "Codex", "Cx"],
  ["pi_cli", "Pi", "Pi"],
];

describe("agent identity keyed by the daemon's agent ids", () => {
  it.each(DAEMON_AGENTS)("renders %s with its brand tile and name", (id, name, monogram) => {
    render(<AgentTile agent={id} />);
    const tile = screen.getByText(monogram);
    expect(tile).toHaveAttribute("data-agent", id);
    expect(isKnownAgent(id)).toBe(true);
    expect(agentDisplayName(id)).toBe(name);
    expect(agentMonogram(id)).toBe(monogram);
  });

  it("names Codex Desktop sessions as the Codex app, on Codex's tile", () => {
    render(<AgentTile agent="codex_desktop" />);
    const tile = screen.getByText("Cx");
    expect(tile).toHaveAttribute("data-agent", "codex_desktop");
    expect(isKnownAgent("codex_desktop")).toBe(true);
    expect(agentDisplayName("codex_desktop")).toBe("Codex app");
    expect(agentDisplayName("codex_desktop")).not.toBe(agentDisplayName("codex_cli"));
  });

  it("files Codex Desktop sessions under the one Codex integration", () => {
    expect(agentIntegrationId("codex_desktop")).toBe("codex_cli");
    for (const [id] of DAEMON_AGENTS) expect(agentIntegrationId(id)).toBe(id);
    expect(agentIntegrationId("gemini_cli")).toBe("gemini_cli");
  });

  it.each(["claude", "codex", "pi"])("treats the old short id %s as unknown", (shortId) => {
    render(<AgentTile agent={shortId} />);
    expect(isKnownAgent(shortId)).toBe(false);
    expect(agentDisplayName(shortId)).toBe(shortId);
    expect(document.querySelector(".bp-agent-tile")).toHaveAttribute("data-agent", "unknown");
  });

  it("uses daemon ids in the shared status fixture", () => {
    expect(fixtureStatus.agents.map((agent) => agent.id)).toEqual(["claude_code", "codex_cli"]);
    for (const agent of fixtureStatus.agents) expect(isKnownAgent(agent.id)).toBe(true);
  });
});
