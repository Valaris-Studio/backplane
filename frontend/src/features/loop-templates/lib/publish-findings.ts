// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { LoopTemplateFinding } from "../api/loop-templates";
import type { LoopTemplateTab } from "../components/LoopTemplateDetailPage";

// A publish 422 carries validator findings whose `field` is a dotted path into
// the template content (backend `validate_template`). Mapping that path to the
// tab that owns the field is what turns a wall of error text into one click.

const FIELD_ROOT_TABS: Record<string, LoopTemplateTab> = {
  system_prompt: "prompts",
  loop_prompt: "prompts",
  rendered: "prompts",
  slots: "slots",
  slot_values: "slots",
  tools: "rails",
  derived_rails: "rails",
  rails_defaults: "rails",
  setup_contract: "contract",
  template: "prompts",
};

/**
 * The tab that owns `field`.
 *
 * Unknown roots fall back to `prompts` rather than dropping the link: a
 * backend that grows a finding kind should still give the operator somewhere
 * to click, and the prompts tab is where authoring starts.
 */
export function findingTab(field: string): LoopTemplateTab {
  const root = field.split(".")[0] ?? "";
  return FIELD_ROOT_TABS[root] ?? "prompts";
}

/**
 * Findings out of a 422 body, whatever shape the error arrived in.
 *
 * The shared axios interceptor stringifies a non-string `detail` into
 * `error.message` while preserving the structured value on `error.detail`, so
 * both are accepted here — a caller should never have to know which one the
 * transport chose.
 */
export function findingsFrom(detail: unknown): LoopTemplateFinding[] {
  const parsed = typeof detail === "string" ? tryParse(detail) : detail;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is LoopTemplateFinding =>
      !!item && typeof item === "object" && typeof item.field === "string",
  );
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
