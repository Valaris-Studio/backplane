// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Level 4 of the tree: the fields the per-kind editors in pipeline-builder/kinds
// edit today, flattened into read-only `key: value-summary` rows. Editing lands
// in cards 3-4 — this module deliberately produces DATA, not controls, so the
// editing card can attach an editor to a row without re-deriving what a row is.

import type { DraftStage, DraftStep } from "../pipeline-builder/lifecycleDraft";

export interface TreePropertyRow {
  key: string;
  value: string;
}

export interface TreePropertyGroup {
  /** Stable within its owner — feeds propertyGroupNodeId(). */
  group: string;
  /** i18n key for the group heading; falls back to the raw group name. */
  labelKey: string;
  rows: TreePropertyRow[];
}

// Values are summarized, never dumped: an operator scanning a collapsed tree
// wants "3 tools" and "Read, Edit" — not a wrapped JSON blob.
export function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value === "" ? "—" : value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map((v) => summarizeValue(v)).join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return entries.map(([k, v]) => `${k}: ${summarizeValue(v)}`).join(", ");
  }
  return String(value);
}

function rowsFrom(source: Record<string, unknown> | undefined): TreePropertyRow[] {
  if (!source) return [];
  return Object.entries(source)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ key, value: summarizeValue(v) }));
}

export function stepPropertyGroups(step: DraftStep): TreePropertyGroup[] {
  const groups: TreePropertyGroup[] = [];

  const params = (step as { params?: Record<string, unknown> }).params;
  const paramRows = rowsFrom(params);
  if (paramRows.length > 0) {
    groups.push({
      group: "params",
      labelKey: "pipelineTree.group.params",
      rows: paramRows,
    });
  }

  // Routing is separated from params because it is what the north-star diagram
  // will draw as EDGES — keeping it its own group means the diagram card reads
  // one group rather than filtering a params bag.
  const routing = rowsFrom({
    next: step.next,
    on_failure: step.on_failure,
    branches: step.branches,
  });
  if (routing.length > 0) {
    groups.push({
      group: "routing",
      labelKey: "pipelineTree.group.routing",
      rows: routing,
    });
  }

  return groups;
}

export function rolePropertyGroups(stage: DraftStage): TreePropertyGroup[] {
  const groups: TreePropertyGroup[] = [];

  const legacy: Array<[string, string, Record<string, unknown> | undefined]> = [
    ["discover", "pipelineTree.group.discover", stage.discover as unknown as Record<string, unknown>],
    ["claim", "pipelineTree.group.claim", stage.claim as unknown as Record<string, unknown>],
    ["git", "pipelineTree.group.git", stage.git as unknown as Record<string, unknown>],
    ["llm", "pipelineTree.group.llm", stage.llm as unknown as Record<string, unknown>],
  ];

  for (const [group, labelKey, source] of legacy) {
    const rows = rowsFrom(source);
    if (rows.length > 0) groups.push({ group, labelKey, rows });
  }

  if (stage.sensors && stage.sensors.length > 0) {
    groups.push({
      group: "sensors",
      labelKey: "pipelineTree.group.sensors",
      rows: stage.sensors.map((s) => ({
        key: s.name,
        value: summarizeValue(s.config),
      })),
    });
  }

  return groups;
}
