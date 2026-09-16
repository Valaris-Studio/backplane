// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { VALARIS_MCP_TOOL_NAMES } from "@/features/agents/lib/toolCatalog";
import { CATEGORIES, GROUPS } from "../categories";
import { TOOL_DOCS } from "../index";

const CATALOG_NAMES = new Set(VALARIS_MCP_TOOL_NAMES);
const REGISTERED_CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));

describe("MCP reference tool docs parity", () => {
  it("documents exactly the tool set in toolCatalog.ts", () => {
    const documented = new Set(TOOL_DOCS.map((doc) => doc.name));
    const missing = [...CATALOG_NAMES].filter((name) => !documented.has(name)).sort();
    const unknown = [...documented].filter((name) => !CATALOG_NAMES.has(name)).sort();
    expect({ missing, unknown }).toEqual({ missing: [], unknown: [] });
  });

  it("has no duplicate tool names", () => {
    const names = TOOL_DOCS.map((doc) => doc.name);
    const duplicates = names.filter((name, i) => names.indexOf(name) !== i);
    expect(duplicates).toEqual([]);
  });

  it("gives every doc a tight description, an example prompt, and a registered category", () => {
    for (const doc of TOOL_DOCS) {
      expect(doc.description.trim().length, `${doc.name}: empty description`).toBeGreaterThan(0);
      expect(
        doc.description.length,
        `${doc.name}: description over 170 chars (${doc.description.length})`,
      ).toBeLessThanOrEqual(170);
      expect(doc.examplePrompt.trim().length, `${doc.name}: empty examplePrompt`).toBeGreaterThan(0);
      expect(
        REGISTERED_CATEGORY_IDS.has(doc.category),
        `${doc.name}: unregistered category "${doc.category}"`,
      ).toBe(true);
    }
  });

  it("assigns every category to a registered navigation group", () => {
    const registeredGroups = new Set<string>(GROUPS);
    const invalidGroups = CATEGORIES.flatMap(({ id, group }) =>
      registeredGroups.has(group) ? [] : [{ id, group }],
    );

    expect(invalidGroups).toEqual([]);
  });

  it("points every related entry at a real tool name", () => {
    for (const doc of TOOL_DOCS) {
      for (const related of doc.related ?? []) {
        expect(
          CATALOG_NAMES.has(related),
          `${doc.name}: related "${related}" is not a catalog tool`,
        ).toBe(true);
      }
    }
  });
});
