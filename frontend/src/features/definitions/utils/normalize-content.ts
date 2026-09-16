// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  DefinitionContent,
  Objective,
  Stakeholder,
  KeyDecision,
} from "@/types/definition";

const KNOWN_KEYS = new Set([
  "objectives",
  "exclusions",
  "non_goals",
  "milestones",
  "tech_stack",
  "stakeholders",
  "constraints",
  "decisions",
  "decisions_log",
  "references",
  "custom_fields",
  "_overflow",
]);

function normalizeObjectives(raw: unknown): Objective[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") return { text: item, priority: null };
    if (item && typeof item === "object" && "text" in item) {
      return { text: item.text, priority: item.priority ?? null };
    }
    return { text: String(item), priority: null };
  });
}

function normalizeTechStack(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string");
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.values(raw as Record<string, unknown>).flatMap((val) =>
      Array.isArray(val) ? val.filter((v) => typeof v === "string") : [],
    );
  }
  return [];
}

function normalizeStakeholders(raw: unknown): Stakeholder[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    name: item?.name ?? "",
    role: item?.role ?? "",
    member_id: item?.member_id ?? null,
    channel_id: item?.channel_id ?? null,
  }));
}

function normalizeDecisions(raw: unknown): KeyDecision[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => ({
    decision: item?.decision ?? "",
    rationale: item?.rationale ?? "",
  }));
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => typeof v === "string");
}

export function normalizeDefinitionContent(
  raw: Record<string, unknown>,
): DefinitionContent {
  const overflow: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      overflow[key] = raw[key];
    }
  }

  return {
    objectives: normalizeObjectives(raw.objectives),
    exclusions: normalizeStringArray(raw.exclusions ?? raw.non_goals),
    milestones: Array.isArray(raw.milestones) ? raw.milestones : [],
    tech_stack: normalizeTechStack(raw.tech_stack),
    stakeholders: normalizeStakeholders(raw.stakeholders),
    constraints: normalizeStringArray(raw.constraints),
    decisions: normalizeDecisions(raw.decisions ?? raw.decisions_log),
    references: Array.isArray(raw.references) ? raw.references : [],
    custom_fields: Array.isArray(raw.custom_fields) ? raw.custom_fields : [],
    _overflow: overflow,
  };
}

export function denormalizeDefinitionContent(
  content: DefinitionContent,
): Record<string, unknown> {
  const { _overflow, ...rest } = content;
  return { ...rest, ..._overflow };
}
