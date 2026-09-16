// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  declaredAliasesForStage,
  lintContextSourceWiring,
  CONTEXT_SOURCE_SNIPPET,
} from "../contextSourceWiring";
import type { PipelineConfig, StageConfig } from "../../api/pipelineConfig";

function stage(
  role: string,
  llmStage: string,
  sources: { kind: string; as?: string }[],
): StageConfig {
  return {
    role,
    discover: { strategy: "", column_type: "", column_type_exclude: "", filters: {} },
    claim: { participant_role: "", execution_action: "" },
    git: { action: "", branch_prefix: "", create_pr: false, force_push_on_rework: false },
    llm: {
      enabled: true,
      stage: llmStage,
      tools: [],
      inject_directives: false,
      approval_enabled: false,
      context_sources: sources,
    },
    sensors: [],
  };
}

function pipeline(stages: StageConfig[]): PipelineConfig {
  return { version: 1, stages, scheduling: { priority_order: [], mode: "priority" } };
}

describe("declaredAliasesForStage", () => {
  it("returns kind as alias when `as` omitted", () => {
    const cfg = pipeline([stage("implementer", "implement", [{ kind: "pipeline_expectations" }])]);
    expect(declaredAliasesForStage(cfg, "implementer", "implement")).toEqual([
      "pipeline_expectations",
    ]);
  });

  it("honors custom `as` alias", () => {
    const cfg = pipeline([
      stage("implementer", "implement", [{ kind: "linked_cards", as: "deps" }]),
    ]);
    expect(declaredAliasesForStage(cfg, "implementer", "implement")).toEqual(["deps"]);
  });

  it("returns empty when no matching stage", () => {
    const cfg = pipeline([stage("implementer", "implement", [{ kind: "linked_cards" }])]);
    expect(declaredAliasesForStage(cfg, "reviewer", "review")).toEqual([]);
  });
});

describe("CONTEXT_SOURCE_SNIPPET", () => {
  it("produces the index form, not the dotted variable form", () => {
    expect(CONTEXT_SOURCE_SNIPPET("deps")).toBe('{{ index .ContextSources "deps" }}');
  });
});

describe("lintContextSourceWiring", () => {
  it("warns on declared-but-unreferenced", () => {
    const declared = ["pipeline_expectations"];
    const findings = lintContextSourceWiring(declared, "no references here");
    expect(findings.map((f) => f.code)).toContain(
      "context_source_declared_but_unreferenced",
    );
  });

  it("does not warn when referenced", () => {
    const declared = ["pipeline_expectations"];
    const content = '{{ index .ContextSources "pipeline_expectations" }}';
    expect(lintContextSourceWiring(declared, content)).toEqual([]);
  });

  it("matches whitespace-free index form", () => {
    const declared = ["deps"];
    const content = '{{index .ContextSources "deps"}}';
    expect(lintContextSourceWiring(declared, content)).toEqual([]);
  });

  it("warns on referenced-but-undeclared", () => {
    const findings = lintContextSourceWiring(
      [],
      '{{ index .ContextSources "linked_cards" }}',
    );
    expect(findings.map((f) => f.code)).toContain(
      "context_source_referenced_but_undeclared",
    );
  });

  it("does not flag the legacy bridge aliases as undeclared", () => {
    const findings = lintContextSourceWiring(
      [],
      '{{ index .ContextSources "board_definition" }}',
    );
    expect(findings.map((f) => f.code)).not.toContain(
      "context_source_referenced_but_undeclared",
    );
  });

  it("tags all findings severity=warning", () => {
    const findings = lintContextSourceWiring(["pipeline_expectations"], "nothing");
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });
});
