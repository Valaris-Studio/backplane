// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { PROMPT_ROLE_LABELS } from "./roleLabels";
import {
  CATEGORIES,
  GROUPS,
  PROMPT_DOCS,
  RESOURCE_DOCS,
  TOOL_DOCS,
} from "./data";

/**
 * Narrative rendered lazily by the MCP explorer. The section tree cannot see
 * these strings until a user selects an entry, so the documentation release
 * gate registers them explicitly while keeping tool ids, parameter names,
 * enum values and example prompt code blocks in the shared source catalog.
 */
export function collectMcpReferenceTranslatableStrings(): string[] {
  const strings = new Set<string>();
  const add = (value: string | undefined) => {
    if (value) strings.add(value);
  };

  GROUPS.forEach(add);
  CATEGORIES.forEach((category) => add(category.title));

  TOOL_DOCS.forEach((tool) => {
    add(tool.description);
    tool.params.forEach((param) => add(param.description));
    tool.gotchas?.forEach(add);
    add(tool.danger);
  });

  PROMPT_DOCS.forEach((prompt) => {
    add(PROMPT_ROLE_LABELS[prompt.role]);
    add(prompt.description);
    prompt.params.forEach((param) => add(param.description));
  });

  RESOURCE_DOCS.forEach((resource) => add(resource.description));

  return [...strings];
}
