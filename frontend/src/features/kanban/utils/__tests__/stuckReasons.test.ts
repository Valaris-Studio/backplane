// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  computeStuckReasons,
  STALE_THRESHOLD_DAYS,
  type StuckReason,
} from "../stuckReasons";
import type { Card, Column } from "@/types/kanban";
import type { Execution } from "@/features/agents/api/agents";
import type { StageConfig } from "@/features/agents/api/pipelineConfig";

function makeStage(role: string, participantRole: "hero" | "helper"): StageConfig {
  return {
    role,
    discover: { strategy: "unassigned_or_rework", column_type: "", column_type_exclude: "", filters: {} },
    claim: { participant_role: participantRole, execution_action: role },
    git: { action: "none", branch_prefix: "", create_pr: false, force_push_on_rework: false },
    llm: { enabled: false, stage: role, tools: [], inject_directives: false, approval_enabled: false },
    sensors: [],
    on_success: {},
    on_failure: {},
  };
}

const NOW = new Date("2026-04-18T12:00:00Z");

function makeCard(partial: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Test card",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-10T00:00:00Z",
    updated_at: "2026-04-18T00:00:00Z",
    ...partial,
  };
}

function makeColumn(type: Column["column_type"]): Column {
  return {
    id: "col-1",
    name: type ?? "untyped",
    position: 1024,
    board_id: "board-1",
    column_type: type,
    cards: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  };
}

function makeExecution(partial: Partial<Execution> = {}): Execution {
  return {
    id: "exec-1",
    agent_id: "agent-1",
    workspace_id: "ws-1",
    board_id: "board-1",
    session_id: null,
    action: "implement",
    status: "completed",
    started_at: "2026-04-18T11:00:00Z",
    completed_at: "2026-04-18T11:05:00Z",
    input_summary: "",
    output_summary: null,
    tools_used: null,
    cards_affected: ["card-1"],
    cards_affected_detail: [],
    error_message: null,
    tool_calls_count: 0,
    tokens_used: null,
    cost_usd: null,
    duration_seconds: null,
    parent_execution_id: null,
    role: "implementer",
    prompt_slug: null,
    model: null,
    provider: null,
    input_prompt: null,
    tool_invocations: [],
    ...partial,
  };
}

function keysOf(reasons: StuckReason[]): string[] {
  return reasons.map((r) => r.key);
}

describe("computeStuckReasons", () => {
  it("returns empty when the card is in a done column", () => {
    const result = computeStuckReasons({
      card: makeCard({ participants: [] }),
      column: makeColumn("done"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(result).toEqual([]);
  });

  it("flags blocked column when column_type is blocked", () => {
    const result = computeStuckReasons({
      card: makeCard(),
      column: makeColumn("blocked"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(result)).toContain("blockedColumn");
  });

  it("flags noHero when the card has no hero participant", () => {
    const result = computeStuckReasons({
      card: makeCard({ participants: [] }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(result)).toContain("noHero");
  });

  it("does not flag noHero when a hero participant exists", () => {
    const card = makeCard({
      participants: [
        {
          user_id: "u1",
          agent_id: "a1",
          role: "hero",
          added_at: NOW.toISOString(),
          user: {
            id: "u1",
            name: "Hero",
            email: "h@test",
            avatar_url: null,
          },
          agent: { id: "a1", name: "impl", agent_type: "implementer" },
        },
      ],
    });
    const result = computeStuckReasons({
      card,
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(result)).not.toContain("noHero");
  });

  it("flags awaitingPrompt with the stage count", () => {
    const result = computeStuckReasons({
      card: makeCard({
        participants: [
          {
            user_id: "u1",
            agent_id: "a1",
            role: "hero",
            added_at: NOW.toISOString(),
            user: { id: "u1", name: "H", email: "h@t", avatar_url: null },
            agent: { id: "a1", name: "a", agent_type: "i" },
          },
        ],
      }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 3,
      latestReview: null,
      now: NOW,
    });
    const awaiting = result.find((r) => r.key === "awaitingPrompt");
    expect(awaiting).toBeDefined();
    expect(awaiting?.values).toEqual({ count: 3 });
  });

  it("flags requestChanges when the latest review is request_changes", () => {
    const result = computeStuckReasons({
      card: makeCard({
        participants: [
          {
            user_id: "u1",
            agent_id: "a1",
            role: "hero",
            added_at: NOW.toISOString(),
            user: { id: "u1", name: "H", email: "h@t", avatar_url: null },
            agent: { id: "a1", name: "a", agent_type: "i" },
          },
        ],
      }),
      column: makeColumn("review"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: "request_changes",
      now: NOW,
    });
    expect(keysOf(result)).toContain("requestChanges");
  });

  it("flags recentFailures only when two or more failures fall within the 24h window", () => {
    const card = makeCard({
      participants: [
        {
          user_id: "u1",
          agent_id: "a1",
          role: "hero",
          added_at: NOW.toISOString(),
          user: { id: "u1", name: "H", email: "h@t", avatar_url: null },
          agent: { id: "a1", name: "a", agent_type: "i" },
        },
      ],
    });
    const justOne = computeStuckReasons({
      card,
      column: makeColumn("active"),
      cardExecutions: [
        makeExecution({ id: "e1", status: "failed", started_at: "2026-04-18T10:00:00Z" }),
      ],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(justOne)).not.toContain("recentFailures");

    const twoInWindow = computeStuckReasons({
      card,
      column: makeColumn("active"),
      cardExecutions: [
        makeExecution({ id: "e1", status: "failed", started_at: "2026-04-18T10:00:00Z" }),
        makeExecution({ id: "e2", status: "failed", started_at: "2026-04-18T06:00:00Z" }),
      ],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    const failures = twoInWindow.find((r) => r.key === "recentFailures");
    expect(failures?.values).toEqual({ count: 2 });
  });

  it("ignores failures older than the 24h window", () => {
    const result = computeStuckReasons({
      card: makeCard({
        participants: [
          {
            user_id: "u1",
            agent_id: "a1",
            role: "hero",
            added_at: NOW.toISOString(),
            user: { id: "u1", name: "H", email: "h@t", avatar_url: null },
            agent: { id: "a1", name: "a", agent_type: "i" },
          },
        ],
      }),
      column: makeColumn("active"),
      cardExecutions: [
        makeExecution({ id: "old-1", status: "failed", started_at: "2026-04-15T00:00:00Z" }),
        makeExecution({ id: "old-2", status: "failed", started_at: "2026-04-14T00:00:00Z" }),
      ],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(result)).not.toContain("recentFailures");
  });

  it("flags staleness only when no other reason applies and updated_at is past the threshold", () => {
    const staleDate = new Date(NOW);
    staleDate.setDate(staleDate.getDate() - (STALE_THRESHOLD_DAYS + 1));
    const result = computeStuckReasons({
      card: makeCard({
        updated_at: staleDate.toISOString(),
        participants: [
          {
            user_id: "u1",
            agent_id: "a1",
            role: "hero",
            added_at: staleDate.toISOString(),
            user: { id: "u1", name: "H", email: "h@t", avatar_url: null },
            agent: { id: "a1", name: "a", agent_type: "i" },
          },
        ],
      }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    const stale = result.find((r) => r.key === "stale");
    expect(stale).toBeDefined();
    expect(stale?.values?.days).toBeGreaterThanOrEqual(STALE_THRESHOLD_DAYS);
  });

  it("suppresses staleness when any other reason is already present", () => {
    const staleDate = new Date(NOW);
    staleDate.setDate(staleDate.getDate() - (STALE_THRESHOLD_DAYS + 1));
    const result = computeStuckReasons({
      card: makeCard({ updated_at: staleDate.toISOString(), participants: [] }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    // noHero fires first; stale should NOT also fire.
    expect(keysOf(result)).toContain("noHero");
    expect(keysOf(result)).not.toContain("stale");
  });

  it("suppresses noHero when the pipeline has no hero-claiming stage", () => {
    // Custom pipeline with only helper-claim stages (e.g., an observer-only
    // workspace where nothing ever claims as hero). "No hero" is not a real
    // blocker there.
    const result = computeStuckReasons({
      card: makeCard({ participants: [] }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      pipelineStages: [makeStage("observer", "helper")],
      now: NOW,
    });
    expect(keysOf(result)).not.toContain("noHero");
  });

  it("keeps noHero when the pipeline has any hero-claiming stage, regardless of role name", () => {
    // User has a custom "coder" role that claims as hero. The reason still
    // fires — we gate on the DSL primitive (participant_role), not the name.
    const result = computeStuckReasons({
      card: makeCard({ participants: [] }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      pipelineStages: [makeStage("coder", "hero"), makeStage("checker", "helper")],
      now: NOW,
    });
    expect(keysOf(result)).toContain("noHero");
  });

  it("defaults to surfacing noHero when no pipeline is available", () => {
    // Conservative fallback: if the hook hasn't resolved (undefined) or
    // returned an empty list, we prefer a false positive over hiding a real
    // blocker.
    const result = computeStuckReasons({
      card: makeCard({ participants: [] }),
      column: makeColumn("active"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      pipelineStages: undefined,
      now: NOW,
    });
    expect(keysOf(result)).toContain("noHero");
  });

  it("surfaces reasons in a stable, actionable order", () => {
    const result = computeStuckReasons({
      card: makeCard({ participants: [] }),
      column: makeColumn("blocked"),
      cardExecutions: [
        makeExecution({ id: "e1", status: "failed", started_at: "2026-04-18T10:00:00Z" }),
        makeExecution({ id: "e2", status: "failed", started_at: "2026-04-18T08:00:00Z" }),
      ],
      awaitingPromptCount: 1,
      latestReview: "request_changes",
      now: NOW,
    });
    expect(keysOf(result)).toEqual([
      "blockedColumn",
      "noHero",
      "awaitingPrompt",
      "requestChanges",
      "recentFailures",
    ]);
  });
});

// SWE-AF #2 surfacing: the stuck-loop detector parks a card by appending the
// `needs-advisor` label; the scheduler then skips it for reviewer/coder until
// a human removes the label. The card face must say WHY it stalls, so the
// util gains a `needsAdvisor` reason keyed off the label.
describe("computeStuckReasons — needsAdvisor (stuck-loop park)", () => {
  it("flags needsAdvisor when the card carries the needs-advisor label", () => {
    const result = computeStuckReasons({
      card: makeCard({ labels: ["needs-advisor"] }),
      column: makeColumn("review"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(result)).toContain("needsAdvisor");
  });

  it("does not flag needsAdvisor for other labels", () => {
    const result = computeStuckReasons({
      card: makeCard({ labels: ["ui", "needs-advisor-review"] }),
      column: makeColumn("review"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(keysOf(result)).not.toContain("needsAdvisor");
  });

  it("ranks needsAdvisor first when the column is not blocked", () => {
    // Ordering doctrine (see computeStuckReasons docstring): most actionable
    // first. The park has one precise fix — remove the label — so it must
    // lead the list; here noHero also fires and must come after.
    const result = computeStuckReasons({
      card: makeCard({ labels: ["needs-advisor"], participants: [] }),
      column: makeColumn("review"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: "request_changes",
      now: NOW,
    });
    expect(keysOf(result)[0]).toBe("needsAdvisor");
  });

  it("does not suppress other reasons and is not suppressed by them", () => {
    const result = computeStuckReasons({
      card: makeCard({ labels: ["needs-advisor"], participants: [] }),
      column: makeColumn("review"),
      cardExecutions: [],
      awaitingPromptCount: 2,
      latestReview: "request_changes",
      now: NOW,
    });
    const keys = keysOf(result);
    expect(keys).toContain("needsAdvisor");
    expect(keys).toContain("noHero");
    expect(keys).toContain("awaitingPrompt");
    expect(keys).toContain("requestChanges");
  });

  it("a parked card is not reported as stale", () => {
    // `stale` is the catch-all that only fires when nothing else did. The
    // park IS the something else: a card idle for weeks because it is parked
    // must read "needs advisor", never the misleading generic "stale".
    const result = computeStuckReasons({
      card: makeCard({
        labels: ["needs-advisor"],
        participants: [
          {
            user_id: "u1",
            agent_id: "a1",
            role: "hero",
            added_at: NOW.toISOString(),
            user: {
              id: "u1",
              name: "Hero",
              email: "h@test",
              avatar_url: null,
            },
            agent: { id: "a1", name: "impl", agent_type: "implementer" },
          },
        ],
        updated_at: "2026-03-01T00:00:00Z",
      }),
      column: makeColumn("review"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    const keys = keysOf(result);
    expect(keys).toContain("needsAdvisor");
    expect(keys).not.toContain("stale");
  });

  it("done column suppresses everything, including the park", () => {
    const result = computeStuckReasons({
      card: makeCard({ labels: ["needs-advisor"] }),
      column: makeColumn("done"),
      cardExecutions: [],
      awaitingPromptCount: 0,
      latestReview: null,
      now: NOW,
    });
    expect(result).toEqual([]);
  });
});
