// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Client-side mirror of the backend context-source ↔ prompt wiring lint
// (backend/app/services/agents/context_source_lint.py). Gives the prompt
// editor live feedback as the operator types, before the save round-trips.
// The backend remains the authoritative linter; this is a UX fast-path.

import type { ContextSourceWarning } from "../api/prompts";
import type { PipelineConfig } from "../api/pipelineConfig";

// Two kinds reach prompts through legacy struct fields rather than the index
// form (runner/internal/workloop/prompt_template.go): board_definition →
// {{.ProjectDirectives}}, review_history → {{.ReviewHistory}}. They are always
// reachable, so referencing them via the index form without declaring is not
// an error; declaring them while only using the legacy field is correct wiring.
const LEGACY_BRIDGE_FIELD: Record<string, string> = {
  board_definition: "ProjectDirectives",
  review_history: "ReviewHistory",
};

const INDEX_REF = /\{\{\s*index\s+\.ContextSources\s+"([^"]+)"\s*\}\}/g;

export function CONTEXT_SOURCE_SNIPPET(alias: string): string {
  return `{{ index .ContextSources "${alias}" }}`;
}

// Declared context-source aliases for the stage that a (role, stage) prompt
// drives. Aliases come from the LIVE pipeline config (stage.llm.context_sources),
// not the static prompt_defaults template_variables list.
export function declaredAliasesForStage(
  pipelineConfig: PipelineConfig | null,
  role: string,
  stage: string,
): string[] {
  if (!pipelineConfig) return [];
  const aliases: string[] = [];
  for (const s of pipelineConfig.stages ?? []) {
    if (s.role !== role || s.llm?.stage !== stage) continue;
    for (const src of s.llm?.context_sources ?? []) {
      if (!src.kind) continue;
      aliases.push(src.as || src.kind);
    }
  }
  return aliases;
}

function referencedAliases(content: string): Set<string> {
  const found = new Set<string>();
  for (const m of content.matchAll(INDEX_REF)) {
    if (m[1]) found.add(m[1]);
  }
  return found;
}

function referencesLegacyField(content: string, field: string): boolean {
  return new RegExp(`\\.${field}\\b`).test(content);
}

// `declaredKinds` lets callers pass the source kinds so the legacy-bridge
// exception can be applied; when only aliases are known the exception still
// holds for aliases that equal a legacy kind name (the common default case).
export function lintContextSourceWiring(
  declaredAliases: string[],
  content: string,
  declaredKindByAlias: Record<string, string> = {},
): ContextSourceWarning[] {
  const findings: ContextSourceWarning[] = [];
  const referenced = referencedAliases(content);
  const declaredSet = new Set(declaredAliases);

  for (const alias of declaredAliases) {
    if (referenced.has(alias)) continue;
    const kind = declaredKindByAlias[alias] ?? alias;
    const legacyField = LEGACY_BRIDGE_FIELD[kind];
    if (legacyField && referencesLegacyField(content, legacyField)) continue;
    findings.push({
      code: "context_source_declared_but_unreferenced",
      field: alias,
      message: `Context source "${alias}" is declared on this stage but the prompt never references it — the rendered context is silently dropped.`,
      value: alias,
      params: { alias },
      severity: "warning",
    });
  }

  for (const alias of referenced) {
    if (declaredSet.has(alias)) continue;
    if (alias in LEGACY_BRIDGE_FIELD) continue;
    findings.push({
      code: "context_source_referenced_but_undeclared",
      field: alias,
      message: `The prompt references context source "${alias}" but no source declares that alias — it renders to empty string.`,
      value: alias,
      params: { alias },
      severity: "warning",
    });
  }

  return findings;
}
