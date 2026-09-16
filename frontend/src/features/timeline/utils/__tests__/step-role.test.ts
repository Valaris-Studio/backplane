// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  buildAgentRoleIndex,
  resolveStepActor,
  resolveStepRole,
  roleFromSummary,
} from "../step-role";
import type { BoardBaseline, CardSnapshot, TimelineEvent } from "../../types";

// The acting role is taken from the event SUMMARY ("… for role <x>") — the only
// trustworthy per-event signal, since the runner uses ONE agent for ALL roles.
// The board-wide agent index only enriches the chip's name/avatar. Role strings
// are verbatim (any user-defined value), never enumerated.

let seq = 0;
function event(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  seq += 1;
  return {
    id: `evt-${seq}`,
    workspace_id: "ws1",
    board_id: "b1",
    actor_id: "user-1",
    actor_name: "Sebastian",
    actor_email: "s@v.dev",
    agent_id: "agent-7",
    entity_type: "card",
    entity_id: "card1",
    action: "updated",
    summary: "",
    changes: null,
    via_api_key: "agent:runner",
    entity_title: null,
    created_at: "2026-01-01T00:00:00Z",
    before_state: null,
    after_state: null,
    ...overrides,
  };
}

function baseline(role: string, agentId = "agent-7"): BoardBaseline {
  const card: CardSnapshot = {
    id: "card1",
    title: "A card",
    card_type: "task",
    priority: "medium",
    column_id: "col1",
    position: 1024,
    status: null,
    labels: null,
    participants: [
      { user_id: "u-bot", agent_id: agentId, name: "Runner Bot", role, avatar_url: null },
    ],
  };
  return { columns: [], cards: [card] };
}

describe("roleFromSummary", () => {
  it("extracts the role from a 'reserved … for role <x>' summary", () => {
    expect(
      roleFromSummary("reserved card 'A-01 · Design tokens' for role implementer"),
    ).toBe("implementer");
  });

  it("extracts a reviewer role", () => {
    expect(roleFromSummary("reserved card 'X' for role reviewer")).toBe("reviewer");
  });

  it("extracts ANY user-defined role verbatim (hyphens/digits)", () => {
    expect(roleFromSummary("reserved card 'X' for role ux-pilot-9000")).toBe("ux-pilot-9000");
  });

  it("returns null when the summary names no role", () => {
    expect(roleFromSummary("moved card 'A-01' from 'To Do' to 'In Progress'")).toBeNull();
    expect(roleFromSummary("updated card 'A-01': changed branch_name")).toBeNull();
    expect(roleFromSummary("")).toBeNull();
    expect(roleFromSummary(null)).toBeNull();
  });
});

describe("resolveStepRole — summary-driven", () => {
  it("shows the role when the summary names one (agent-driven card event)", () => {
    const ev = event({ summary: "reserved card 'A-01' for role implementer" });
    expect(resolveStepRole(ev)?.role).toBe("implementer");
  });

  it("enriches name/avatar from the board-wide index when available", () => {
    const ev = event({ summary: "reserved card 'A-01' for role implementer" });
    const index = buildAgentRoleIndex([], baseline("reviewer")); // index has the agent's identity
    const resolved = resolveStepRole(ev, index);
    expect(resolved).toEqual({ role: "implementer", name: "Runner Bot", avatarUrl: null });
  });

  it("shows NO chip for an event whose summary names no role (move/update)", () => {
    expect(resolveStepRole(event({ summary: "moved card 'A-01' to 'Done'" }))).toBeNull();
    expect(
      resolveStepRole(event({ summary: "updated card 'A-01': changed branch_name" })),
    ).toBeNull();
  });

  it("shows NO chip for a human actor (no agent_id) even with a role summary", () => {
    expect(
      resolveStepRole(event({ agent_id: null, summary: "reserved card 'A-01' for role reviewer" })),
    ).toBeNull();
  });

  it("shows NO chip for a non-card event", () => {
    expect(
      resolveStepRole(
        event({ entity_type: "note", summary: "created note 'Review: card — approve'" }),
      ),
    ).toBeNull();
  });
});

describe("resolveStepActor — WHO acted on this step (badge on the spotlighted card)", () => {
  it("agent + summary-named role → indexed identity with the acting role", () => {
    const ev = event({ summary: "reserved card 'A-01' for role implementer" });
    const index = buildAgentRoleIndex([], baseline("reviewer"));
    expect(resolveStepActor(ev, index)).toEqual({
      name: "Runner Bot",
      avatarUrl: null,
      role: "implementer",
    });
  });

  it("agent WITHOUT a summary role → indexed identity, role omitted (never guessed)", () => {
    const ev = event({ summary: "moved card 'A-01' to 'Done'" });
    const index = buildAgentRoleIndex([], baseline("reviewer"));
    expect(resolveStepActor(ev, index)).toEqual({
      name: "Runner Bot",
      avatarUrl: null,
      role: null,
    });
  });

  it("agent unknown to the index and no summary role → null (nothing truthful to show)", () => {
    const ev = event({ agent_id: "agent-unknown", summary: "moved card 'A-01' to 'Done'" });
    const index = buildAgentRoleIndex([], baseline("reviewer", "agent-7"));
    expect(resolveStepActor(ev, index)).toBeNull();
  });

  it("agent unknown to the index but summary names the role → role-only badge", () => {
    const ev = event({ agent_id: "agent-unknown", summary: "reserved card 'A-01' for role ux-pilot" });
    expect(resolveStepActor(ev, buildAgentRoleIndex([], null))).toEqual({
      name: "",
      avatarUrl: null,
      role: "ux-pilot",
    });
  });

  it("human actor → actor_name, no role", () => {
    const ev = event({ agent_id: null, actor_name: "Sebastian" });
    expect(resolveStepActor(ev, buildAgentRoleIndex([], null))).toEqual({
      name: "Sebastian",
      avatarUrl: null,
      role: null,
    });
  });

  it("human with an empty name → null", () => {
    const ev = event({ agent_id: null, actor_name: "" });
    expect(resolveStepActor(ev, buildAgentRoleIndex([], null))).toBeNull();
  });
});

describe("buildAgentRoleIndex", () => {
  it("indexes agent_id -> name/role from the baseline cards (legacy runs have null event snapshots)", () => {
    const index = buildAgentRoleIndex([], baseline("reviewer", "agent-7"));
    expect(index.get("agent-7")).toEqual({
      role: "reviewer",
      name: "Runner Bot",
      avatarUrl: null,
    });
  });

  it("also indexes from event participant snapshots", () => {
    const ev = event({
      after_state: {
        id: "card1",
        participants: [
          { user_id: "u", agent_id: "agent-9", name: "Bot Nine", role: "planner", avatar_url: null },
        ],
      } as never,
    });
    const index = buildAgentRoleIndex([ev], null);
    expect(index.get("agent-9")?.name).toBe("Bot Nine");
  });
});
