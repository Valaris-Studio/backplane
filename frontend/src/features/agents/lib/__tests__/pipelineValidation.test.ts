// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { validatePipelineConfig } from "../pipelineValidation";
import type { PipelineConfig } from "../../api/pipelineConfig";

function baseStage(role: string) {
  return {
    role,
    discover: {
      strategy: "unassigned_or_rework",
      column_type: "",
      column_type_exclude: "",
      filters: {},
    },
    claim: { participant_role: "hero", execution_action: "x" },
    git: {
      action: "none",
      branch_prefix: "",
      create_pr: false,
      force_push_on_rework: false,
    },
    llm: {
      enabled: false,
      stage: "",
      post_process_kind: "",
      tools: [],
      inject_directives: false,
      approval_enabled: false,
    },
    sensors: [],
    on_success: {},
    on_failure: {},
  };
}

describe("validatePipelineConfig", () => {
  it("accepts a minimal valid pipeline", () => {
    const config: PipelineConfig = {
      version: 1,
      stages: [baseStage("solo")],
      scheduling: {
        priority_order: ["solo"],
        mode: "priority",
      },
    };
    expect(validatePipelineConfig(config)).toEqual([]);
  });

  it("flags duplicate stage roles", () => {
    const config: PipelineConfig = {
      version: 1,
      stages: [baseStage("a"), baseStage("a")],
      scheduling: {
        priority_order: ["a"],
        mode: "priority",
      },
    };
    const errors = validatePipelineConfig(config);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_stage_role",
          params: { field: "stages[1].role", value: "a" },
        }),
      ]),
    );
  });

  it("flags unknown discover strategy", () => {
    const stage = baseStage("a");
    stage.discover.strategy = "bogus";
    const config: PipelineConfig = {
      version: 1,
      stages: [stage],
      scheduling: {
        priority_order: ["a"],
        mode: "priority",
      },
    };
    const errors = validatePipelineConfig(config);
    expect(errors.some((e) => e.code === "unknown_discover_strategy")).toBe(true);
  });

  it("flags priority_order referencing unknown role", () => {
    const config: PipelineConfig = {
      version: 1,
      stages: [baseStage("a")],
      scheduling: {
        priority_order: ["a", "ghost"],
        mode: "priority",
      },
    };
    const errors = validatePipelineConfig(config);
    expect(
      errors.some(
        (e) => e.code === "priority_order_unknown_role" && e.value === "ghost",
      ),
    ).toBe(true);
  });

  it("flags wake_roles referencing unknown role", () => {
    const stage = baseStage("a");
    stage.on_success = { wake_roles: ["nonexistent"] };
    const config: PipelineConfig = {
      version: 1,
      stages: [stage],
      scheduling: {
        priority_order: ["a"],
        mode: "priority",
      },
    };
    const errors = validatePipelineConfig(config);
    expect(errors.some((e) => e.code === "invalid_wake_role")).toBe(true);
  });

  it("flags mismatched post_process_kind on legacy stage", () => {
    const stage = baseStage("a");
    stage.llm = {
      enabled: true,
      stage: "implement",
      post_process_kind: "produces_decision", // expected "writes_code"
      tools: [],
      inject_directives: false,
      approval_enabled: false,
    };
    const config: PipelineConfig = {
      version: 1,
      stages: [stage],
      scheduling: {
        priority_order: ["a"],
        mode: "priority",
      },
    };
    const errors = validatePipelineConfig(config);
    expect(errors.some((e) => e.code === "mismatched_post_process_kind")).toBe(true);
  });

  it("rejects approval_enabled on non-implement stages", () => {
    const stage = baseStage("a");
    stage.llm = {
      enabled: true,
      stage: "review",
      post_process_kind: "",
      tools: [],
      inject_directives: false,
      approval_enabled: true,
    };
    const config: PipelineConfig = {
      version: 1,
      stages: [stage],
      scheduling: {
        priority_order: ["a"],
        mode: "priority",
      },
    };
    const errors = validatePipelineConfig(config);
    expect(
      errors.some((e) => e.code === "approval_not_supported_for_custom_stage"),
    ).toBe(true);
  });
});
