// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { deriveRoleCapabilities } from "../role-capabilities";
import type { StageConfig } from "@/features/agents/api/pipelineConfig";

// A minimal stage builder — only the fields the derivation reads.
function stage(role: string, lifecycle: StageConfig["lifecycle"], extra: Partial<StageConfig> = {}): StageConfig {
  return {
    role,
    discover: { strategy: "column_scan", column_type: "active", filters: {} } as StageConfig["discover"],
    claim: {} as StageConfig["claim"],
    git: {} as StageConfig["git"],
    llm: {} as StageConfig["llm"],
    sensors: [],
    lifecycle,
    ...extra,
  };
}

describe("deriveRoleCapabilities", () => {
  it("derives writesCode from an llm step with post_process_kind=writes_code", () => {
    const cap = deriveRoleCapabilities(
      stage("implementer", [
        { name: "build", kind: "llm", params: { post_process_kind: "writes_code" } },
        { name: "ship", kind: "ship", params: { to_column_type: "review" } },
      ]),
    );
    expect(cap.writesCode).toBe(true);
    expect(cap.producesDecision).toBe(false);
    expect(cap.opensPR).toBe(false);
  });

  it("derives producesDecision from an llm step with post_process_kind=produces_decision", () => {
    const cap = deriveRoleCapabilities(
      stage("reviewer", [
        { name: "review", kind: "llm", params: { post_process_kind: "produces_decision" } },
      ]),
    );
    expect(cap.producesDecision).toBe(true);
    expect(cap.writesCode).toBe(false);
  });

  it("derives PR lifecycle capabilities from git/create_pr/merge steps", () => {
    const cap = deriveRoleCapabilities(
      stage("reviewer", [
        { name: "approve", kind: "post_pr_review", params: { decision: "approve" } },
        { name: "merge", kind: "merge_pr", params: { strategy: "squash" } },
      ]),
    );
    expect(cap.mergesPR).toBe(true);
    expect(cap.reviewsPR).toBe(true);
  });

  it("derives writesNotes from create_note OR produces_note llm", () => {
    expect(
      deriveRoleCapabilities(
        stage("documentator", [{ name: "note", kind: "create_note", params: { kind: "doc" } }]),
      ).writesNotes,
    ).toBe(true);
    expect(
      deriveRoleCapabilities(
        stage("planner", [{ name: "x", kind: "llm", params: { post_process_kind: "produces_note" } }]),
      ).writesNotes,
    ).toBe(true);
  });

  it("derives mutatesBacklog from create_fix_cards OR mutates_backlog llm", () => {
    expect(
      deriveRoleCapabilities(
        stage("auditor", [{ name: "fix", kind: "create_fix_cards", params: { to_column_type: "active" } }]),
      ).mutatesBacklog,
    ).toBe(true);
    expect(
      deriveRoleCapabilities(
        stage("planner", [{ name: "p", kind: "llm", params: { post_process_kind: "mutates_backlog" } }]),
      ).mutatesBacklog,
    ).toBe(true);
  });

  it("captures the discover column type and the columns it moves cards to", () => {
    const cap = deriveRoleCapabilities(
      stage(
        "implementer",
        [
          { name: "ship", kind: "ship", params: { to_column_type: "review" } },
          { name: "move", kind: "move_card", params: { to_column_type: "done" } },
        ],
        { discover: { strategy: "column_scan", column_type: "active", filters: {} } as StageConfig["discover"] },
      ),
    );
    expect(cap.discoverColumnType).toBe("active");
    expect(cap.movesCardsTo).toEqual(expect.arrayContaining(["review", "done"]));
  });

  it("lists the roles this role wakes (handoff)", () => {
    const cap = deriveRoleCapabilities(
      stage("reviewer", [
        { name: "wake", kind: "wake_role", params: { roles: ["documentator", "rework_mediator"] } },
      ]),
    );
    expect(cap.wakesRoles).toEqual(expect.arrayContaining(["documentator", "rework_mediator"]));
  });

  it("counts lifecycle steps and llm stages, and flags an empty lifecycle gracefully", () => {
    const cap = deriveRoleCapabilities(stage("noop", []));
    expect(cap.stepCount).toBe(0);
    expect(cap.writesCode).toBe(false);
    expect(cap.llmStages).toEqual([]);
    expect(cap.usesApproval).toBe(false);
  });

  it("collects llm stage names and approval usage", () => {
    const cap = deriveRoleCapabilities(
      stage("reviewer", [
        { name: "review", kind: "llm", params: { stage: "review_diff", post_process_kind: "produces_decision", approval_enabled: true } },
      ]),
    );
    expect(cap.llmStages).toEqual(["review_diff"]);
    expect(cap.usesApproval).toBe(true);
  });
});
