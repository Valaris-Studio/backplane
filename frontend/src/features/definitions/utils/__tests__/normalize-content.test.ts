// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  normalizeDefinitionContent,
  denormalizeDefinitionContent,
} from "../normalize-content";
import type { DefinitionContent } from "@/types/definition";

const MCP_PAYLOAD: Record<string, unknown> = {
  objectives: [
    "Build a comprehensive internal platform",
    "Automate delivery workflows",
  ],
  non_goals: ["Public-facing features", "Mobile app"],
  tech_stack: {
    languages: ["Python", "TypeScript"],
    backend_deps: ["FastAPI", "SQLAlchemy"],
    frontend_deps: ["React", "Tailwind"],
    infra: ["Docker", "Cloud Run"],
  },
  stakeholders: [
    { role: "Tech Lead", name: "Alice", email: "alice@valaris.studio" },
    { role: "PM", name: "Bob", email: "bob@valaris.studio" },
  ],
  constraints: ["Must use GCP", "SOC2 compliance"],
  decisions_log: [
    { decision: "Use FastAPI", rationale: "Async performance" },
    { decision: "Tailwind v4", rationale: "CSS-first config" },
  ],
  architecture: { pattern: "layered", layers: ["router", "service", "repo"] },
  features: [
    { name: "Kanban", status: "done" },
    { name: "Definitions", status: "in_progress" },
  ],
  coding_philosophy: "The code IS the documentation",
  deployment: { target: "Cloud Run", region: "us-central1" },
  current_sprint: { name: "Sprint 5", goal: "Card filters" },
};

const EMPTY_CONTENT: DefinitionContent = {
  objectives: [],
  exclusions: [],
  milestones: [],
  tech_stack: [],
  stakeholders: [],
  constraints: [],
  decisions: [],
  references: [],
  custom_fields: [],
  _overflow: {},
};

describe("normalizeDefinitionContent", () => {
  it("transforms full MCP payload correctly", () => {
    const result = normalizeDefinitionContent(MCP_PAYLOAD);

    expect(result.objectives).toEqual([
      { text: "Build a comprehensive internal platform", priority: null },
      { text: "Automate delivery workflows", priority: null },
    ]);
    expect(result.exclusions).toEqual([
      "Public-facing features",
      "Mobile app",
    ]);
    expect(result.milestones).toEqual([]);
    expect(result.tech_stack).toEqual([
      "Python",
      "TypeScript",
      "FastAPI",
      "SQLAlchemy",
      "React",
      "Tailwind",
      "Docker",
      "Cloud Run",
    ]);
    expect(result.stakeholders).toEqual([
      {
        name: "Alice",
        role: "Tech Lead",
        member_id: null,
        channel_id: null,
      },
      { name: "Bob", role: "PM", member_id: null, channel_id: null },
    ]);
    expect(result.constraints).toEqual(["Must use GCP", "SOC2 compliance"]);
    expect(result.decisions).toEqual([
      { decision: "Use FastAPI", rationale: "Async performance" },
      { decision: "Tailwind v4", rationale: "CSS-first config" },
    ]);
    expect(result.references).toEqual([]);
    expect(result.custom_fields).toEqual([]);
    expect(result._overflow).toEqual({
      architecture: MCP_PAYLOAD.architecture,
      features: MCP_PAYLOAD.features,
      coding_philosophy: MCP_PAYLOAD.coding_philosophy,
      deployment: MCP_PAYLOAD.deployment,
      current_sprint: MCP_PAYLOAD.current_sprint,
    });
  });

  it("passes through already-conforming content", () => {
    const conforming: DefinitionContent = {
      objectives: [{ text: "Ship v1", priority: "high" }],
      exclusions: ["Mobile"],
      milestones: [{ title: "Launch", date: "2026-04-01", type: "deadline" }],
      tech_stack: ["React", "FastAPI"],
      stakeholders: [
        { name: "Alice", role: "Lead", member_id: "m1", channel_id: null },
      ],
      constraints: ["Budget cap"],
      decisions: [{ decision: "Use X", rationale: "Because Y" }],
      references: [{ label: "Docs", url: "https://docs.example.com" }],
      custom_fields: [{ key: "env", value: "prod" }],
      _overflow: {},
    };
    const result = normalizeDefinitionContent(
      conforming as unknown as Record<string, unknown>,
    );
    expect(result).toEqual(conforming);
  });

  it("returns EMPTY_CONTENT for empty input", () => {
    expect(normalizeDefinitionContent({})).toEqual(EMPTY_CONTENT);
  });

  it("wraps string[] objectives into {text, priority} objects", () => {
    const result = normalizeDefinitionContent({
      objectives: ["Goal A", "Goal B"],
    });
    expect(result.objectives).toEqual([
      { text: "Goal A", priority: null },
      { text: "Goal B", priority: null },
    ]);
  });

  it("preserves object objectives that already have text+priority", () => {
    const result = normalizeDefinitionContent({
      objectives: [{ text: "Ship it", priority: "high" }],
    });
    expect(result.objectives).toEqual([{ text: "Ship it", priority: "high" }]);
  });

  it("renames non_goals to exclusions", () => {
    const result = normalizeDefinitionContent({
      non_goals: ["No mobile", "No desktop"],
    });
    expect(result.exclusions).toEqual(["No mobile", "No desktop"]);
  });

  it("prefers exclusions over non_goals when both present", () => {
    const result = normalizeDefinitionContent({
      exclusions: ["Explicit exclusion"],
      non_goals: ["Should be ignored"],
    });
    expect(result.exclusions).toEqual(["Explicit exclusion"]);
  });

  it("flattens nested tech_stack object into string[]", () => {
    const result = normalizeDefinitionContent({
      tech_stack: {
        languages: ["Go"],
        tools: ["Docker"],
      },
    });
    expect(result.tech_stack).toEqual(["Go", "Docker"]);
  });

  it("passes through tech_stack string[]", () => {
    const result = normalizeDefinitionContent({
      tech_stack: ["React", "Node"],
    });
    expect(result.tech_stack).toEqual(["React", "Node"]);
  });

  it("reshapes stakeholders with missing fields", () => {
    const result = normalizeDefinitionContent({
      stakeholders: [{ name: "Charlie", role: "Dev", email: "c@test.com" }],
    });
    expect(result.stakeholders).toEqual([
      { name: "Charlie", role: "Dev", member_id: null, channel_id: null },
    ]);
  });

  it("preserves stakeholders with member_id/channel_id", () => {
    const result = normalizeDefinitionContent({
      stakeholders: [
        { name: "Dana", role: "PM", member_id: "m1", channel_id: "c1" },
      ],
    });
    expect(result.stakeholders).toEqual([
      { name: "Dana", role: "PM", member_id: "m1", channel_id: "c1" },
    ]);
  });

  it("renames decisions_log to decisions", () => {
    const result = normalizeDefinitionContent({
      decisions_log: [{ decision: "Use X", rationale: "Speed" }],
    });
    expect(result.decisions).toEqual([
      { decision: "Use X", rationale: "Speed" },
    ]);
  });

  it("prefers decisions over decisions_log when both present", () => {
    const result = normalizeDefinitionContent({
      decisions: [{ decision: "A", rationale: "B" }],
      decisions_log: [{ decision: "C", rationale: "D" }],
    });
    expect(result.decisions).toEqual([{ decision: "A", rationale: "B" }]);
  });

  it("collects unknown fields into _overflow", () => {
    const result = normalizeDefinitionContent({
      constraints: ["Budget"],
      some_random_field: { nested: true },
      another_field: [1, 2, 3],
    });
    expect(result.constraints).toEqual(["Budget"]);
    expect(result._overflow).toEqual({
      some_random_field: { nested: true },
      another_field: [1, 2, 3],
    });
  });
});

describe("denormalizeDefinitionContent", () => {
  it("round-trips: normalize then denormalize preserves overflow", () => {
    const normalized = normalizeDefinitionContent(MCP_PAYLOAD);
    const denormalized = denormalizeDefinitionContent(normalized);

    // Overflow fields are spread back to top-level
    expect(denormalized.architecture).toEqual(MCP_PAYLOAD.architecture);
    expect(denormalized.features).toEqual(MCP_PAYLOAD.features);
    expect(denormalized.coding_philosophy).toBe("The code IS the documentation");
    expect(denormalized.deployment).toEqual(MCP_PAYLOAD.deployment);
    expect(denormalized.current_sprint).toEqual(MCP_PAYLOAD.current_sprint);

    // Standard fields are present
    expect(denormalized.objectives).toEqual(normalized.objectives);
    expect(denormalized.exclusions).toEqual(normalized.exclusions);
    expect(denormalized.constraints).toEqual(normalized.constraints);
    expect(denormalized.decisions).toEqual(normalized.decisions);

    // _overflow key itself is not in the output
    expect(denormalized).not.toHaveProperty("_overflow");
  });

  it("produces clean output with no overflow", () => {
    const content: DefinitionContent = {
      objectives: [{ text: "Ship", priority: "high" }],
      exclusions: [],
      milestones: [],
      tech_stack: ["React"],
      stakeholders: [],
      constraints: [],
      decisions: [],
      references: [],
      custom_fields: [],
      _overflow: {},
    };
    const result = denormalizeDefinitionContent(content);
    expect(result).toEqual({
      objectives: [{ text: "Ship", priority: "high" }],
      exclusions: [],
      milestones: [],
      tech_stack: ["React"],
      stakeholders: [],
      constraints: [],
      decisions: [],
      references: [],
      custom_fields: [],
    });
  });
});
