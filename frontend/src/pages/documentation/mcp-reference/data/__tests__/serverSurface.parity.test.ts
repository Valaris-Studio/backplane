// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORIES, GROUP_IDS, GROUPS, slugifyGroup } from "../categories";
import { getServerSurface, TOOL_DOCS } from "../index";

// Written by mcp-server/scripts/export-tool-catalog.py — the wire-level view
// of the MCP surface (annotations + descriptions) that the docs render next
// to the hand-written ToolDoc prose. Missing or stale => regenerate.
const FIXTURE_PATH = resolve(
  process.cwd(),
  "src/pages/documentation/mcp-reference/data/server-surface.json",
);
const REGEN_HINT =
  "server-surface.json is missing — regenerate: cd mcp-server && .venv/bin/python scripts/export-tool-catalog.py";

interface ServerSurfaceAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

interface ServerSurfaceTool {
  title: string;
  category: string;
  kind: string;
  annotations: ServerSurfaceAnnotations;
  description: string;
  params: Record<string, string>;
}

interface ServerSurface {
  tool_count: number;
  listing_bytes: number;
  tools: Record<string, ServerSurfaceTool>;
}

function loadServerSurface(): ServerSurface {
  expect(existsSync(FIXTURE_PATH), REGEN_HINT).toBe(true);
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ServerSurface;
}

describe("server-surface.json parity with TOOL_DOCS", () => {
  it("lists exactly the tool names documented in TOOL_DOCS", () => {
    const surface = loadServerSurface();
    const fixtureNames = new Set(Object.keys(surface.tools));
    const documented = new Set(TOOL_DOCS.map((doc) => doc.name));

    const missingFromFixture = [...documented]
      .filter((name) => !fixtureNames.has(name))
      .sort();
    const unknownInFixture = [...fixtureNames]
      .filter((name) => !documented.has(name))
      .sort();

    expect({ missingFromFixture, unknownInFixture }).toEqual({
      missingFromFixture: [],
      unknownInFixture: [],
    });
  });

  it("reports tool_count equal to the number of documented tools", () => {
    const surface = loadServerSurface();
    expect(surface.tool_count).toBe(TOOL_DOCS.length);
    expect(Object.keys(surface.tools)).toHaveLength(TOOL_DOCS.length);
  });

  it("agrees with every ToolDoc on kind and category", () => {
    const surface = loadServerSurface();
    const mismatches = TOOL_DOCS.flatMap((doc) => {
      const wire = surface.tools[doc.name];
      if (wire === undefined) return [{ name: doc.name, reason: "absent" }];
      const drift: string[] = [];
      if (wire.kind !== doc.kind) drift.push(`kind ${wire.kind} != ${doc.kind}`);
      if (wire.category !== doc.category) {
        drift.push(`category ${wire.category} != ${doc.category}`);
      }
      return drift.length === 0 ? [] : [{ name: doc.name, reason: drift.join("; ") }];
    });

    expect(mismatches).toEqual([]);
  });

  it("flags every ToolDoc with a danger note as destructive on the wire", () => {
    const surface = loadServerSurface();
    const dangerNotDestructive = TOOL_DOCS.filter(
      (doc) =>
        doc.danger !== undefined &&
        surface.tools[doc.name]?.annotations.destructiveHint !== true,
    ).map((doc) => doc.name);

    expect(dangerNotDestructive).toEqual([]);
  });

  it("gives every tool a title, a wire description, and three boolean hints", () => {
    const surface = loadServerSurface();
    const offenders = Object.entries(surface.tools).flatMap(([name, wire]) => {
      const problems: string[] = [];
      if (typeof wire.title !== "string" || wire.title.trim().length === 0) {
        problems.push("empty title");
      }
      if (
        typeof wire.description !== "string" ||
        wire.description.trim().length === 0
      ) {
        problems.push("empty description");
      }
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
      ] as const) {
        if (typeof wire.annotations?.[hint] !== "boolean") {
          problems.push(`${hint} is not a boolean`);
        }
      }
      if (typeof wire.params !== "object" || wire.params === null) {
        problems.push("params is not an object");
      }
      return problems.length === 0 ? [] : [`${name}: ${problems.join(", ")}`];
    });

    expect(offenders).toEqual([]);
  });

  it("keeps read-only tools non-destructive on the wire", () => {
    const surface = loadServerSurface();
    const readOnlyButDestructive = Object.entries(surface.tools)
      .filter(
        ([, wire]) =>
          wire.annotations.readOnlyHint === true &&
          wire.annotations.destructiveHint === true,
      )
      .map(([name]) => name);

    expect(readOnlyButDestructive).toEqual([]);
  });

  it("records a positive listing byte count", () => {
    const surface = loadServerSurface();
    expect(Number.isInteger(surface.listing_bytes)).toBe(true);
    expect(surface.listing_bytes).toBeGreaterThan(0);
  });
});

// --- MCP #2: toolsets -------------------------------------------------------
//
// The fixture also carries `toolsets` (one entry per group and per category,
// taxonomy order, each with its sorted tool names) and `default_toolset` (the
// interactive default hand: ids, exclusions and inclusions with reasons,
// resolved tools = union(ids) − exclusions ∪ inclusions). The server derives
// group ids from the group titles; the frontend derives the same ids with
// categories.slugifyGroup (GROUP_IDS) and both are pinned against the fixture.
interface FixtureToolset {
  id: string;
  kind: "group" | "category";
  title: string;
  group: string;
  tools: string[];
}

interface FixtureDefaultToolset {
  ids: string[];
  exclusions: Record<string, string>;
  inclusions: Record<string, string>;
  tools: string[];
}

interface ServerSurfaceWithToolsets extends ServerSurface {
  toolsets?: FixtureToolset[];
  default_toolset?: FixtureDefaultToolset;
}

const TOOLSETS_REGEN_HINT =
  "server-surface.json has no toolsets/default_toolset — regenerate: cd mcp-server && .venv/bin/python scripts/export-tool-catalog.py";

// Never allowed in the default hand regardless of what the fixture says.
const NEVER_IN_DEFAULT_HAND = ["delete_workspace", "delete_board"];

// Every tool in the group toolsets the default hand loads (before the
// exclusion/inclusion tables are applied).
function loadedGroupUnion(
  toolsets: FixtureToolset[],
  defaultToolset: FixtureDefaultToolset,
): Set<string> {
  const union = new Set<string>();
  for (const { id, kind, tools } of toolsets) {
    if (kind === "group" && defaultToolset.ids.includes(id)) {
      for (const name of tools) union.add(name);
    }
  }
  return union;
}

function loadToolsets(): {
  toolsets: FixtureToolset[];
  defaultToolset: FixtureDefaultToolset;
} {
  const surface = loadServerSurface() as ServerSurfaceWithToolsets;
  expect(Array.isArray(surface.toolsets), TOOLSETS_REGEN_HINT).toBe(true);
  expect(surface.default_toolset, TOOLSETS_REGEN_HINT).toBeTypeOf("object");
  return {
    toolsets: surface.toolsets as FixtureToolset[],
    defaultToolset: surface.default_toolset as FixtureDefaultToolset,
  };
}

describe("server-surface.json toolsets parity", () => {
  const documentedNames = new Set(TOOL_DOCS.map((doc) => doc.name));

  it("gives every toolset an id, a kind, a title, a group, and a sorted tools array", () => {
    const { toolsets } = loadToolsets();
    expect(toolsets.length).toBeGreaterThan(0);
    const offenders = toolsets.flatMap((entry, index) => {
      const problems: string[] = [];
      if (typeof entry.id !== "string" || entry.id.trim() === "") problems.push("empty id");
      if (entry.kind !== "group" && entry.kind !== "category") {
        problems.push(`kind ${String(entry.kind)} is not group|category`);
      }
      if (typeof entry.title !== "string" || entry.title.trim() === "") problems.push("empty title");
      if (typeof entry.group !== "string" || entry.group.trim() === "") problems.push("empty group");
      if (!Array.isArray(entry.tools)) {
        problems.push("tools is not an array");
      } else {
        if (entry.tools.length === 0) problems.push("tools is empty");
        const sorted = entry.tools.slice().sort();
        if (sorted.join(",") !== entry.tools.join(",")) problems.push("tools not sorted");
        const unknown = entry.tools.filter((name) => !documentedNames.has(name));
        if (unknown.length) problems.push(`unknown tools: ${unknown.join(", ")}`);
      }
      return problems.length === 0 ? [] : [`#${index} ${entry.id}: ${problems.join(", ")}`];
    });
    expect(offenders).toEqual([]);
  });

  it("uses unique ids and never the reserved words all/default", () => {
    const { toolsets } = loadToolsets();
    const ids = toolsets.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("all");
    expect(ids).not.toContain("default");
  });

  it("partitions every TOOL_DOCS name into exactly one group toolset", () => {
    const { toolsets } = loadToolsets();
    const groupToolsets = toolsets.filter(({ kind }) => kind === "group");
    expect(groupToolsets).toHaveLength(GROUPS.length);

    const seen = new Map<string, number>();
    for (const { tools } of groupToolsets) {
      for (const name of tools) seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    const missing = [...documentedNames].filter((name) => !seen.has(name)).sort();
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([name]) => name).sort();
    const unknown = [...seen.keys()].filter((name) => !documentedNames.has(name)).sort();
    expect({ missing, duplicated, unknown }).toEqual({ missing: [], duplicated: [], unknown: [] });
  });

  it("lists group toolsets under the group title they slugify from", () => {
    const { toolsets } = loadToolsets();
    const groupToolsets = toolsets.filter(({ kind }) => kind === "group");
    expect(groupToolsets.map(({ id }) => id)).toEqual(GROUPS.map(slugifyGroup));
    expect(groupToolsets.map(({ group }) => group)).toEqual([...GROUPS]);
    expect(groupToolsets.map(({ title }) => title)).toEqual([...GROUPS]);
  });

  it("carries one category toolset per CATEGORIES entry, in registry order", () => {
    const { toolsets } = loadToolsets();
    const categoryToolsets = toolsets.filter(({ kind }) => kind === "category");
    expect(categoryToolsets.map(({ id }) => id)).toEqual(CATEGORIES.map(({ id }) => id));
    const groupDrift = categoryToolsets.flatMap(({ id, group }) => {
      const registered = CATEGORIES.find((category) => category.id === id)?.group;
      return registered === group ? [] : [{ id, fixture: group, registered }];
    });
    expect(groupDrift).toEqual([]);
  });

  it("gives each category toolset exactly the TOOL_DOCS names in that category", () => {
    const { toolsets } = loadToolsets();
    const drift = toolsets
      .filter(({ kind }) => kind === "category")
      .flatMap(({ id, tools }) => {
        const expected = TOOL_DOCS.filter((doc) => doc.category === id)
          .map((doc) => doc.name)
          .sort();
        return expected.join(",") === tools.join(",") ? [] : [{ id, expected, tools }];
      });
    expect(drift).toEqual([]);
  });

  it("exports GROUP_IDS from categories.ts equal to the fixture's group ids in order", () => {
    const { toolsets } = loadToolsets();
    const fixtureGroupIds = toolsets.filter(({ kind }) => kind === "group").map(({ id }) => id);
    expect([...GROUP_IDS]).toEqual(fixtureGroupIds);
    expect([...GROUP_IDS]).toEqual(GROUPS.map(slugifyGroup));
  });

  it("exposes the fixture's toolsets and default_toolset through getServerSurface()", () => {
    const { toolsets, defaultToolset } = loadToolsets();
    const surface = getServerSurface();
    expect(surface.toolsets).toEqual(toolsets);
    expect(surface.default_toolset).toEqual(defaultToolset);
  });

  describe("default_toolset", () => {
    it("names only group toolset ids", () => {
      const { toolsets, defaultToolset } = loadToolsets();
      const groupIds = new Set(toolsets.filter(({ kind }) => kind === "group").map(({ id }) => id));
      expect(defaultToolset.ids.length).toBeGreaterThan(0);
      expect(defaultToolset.ids.filter((id) => !groupIds.has(id))).toEqual([]);
    });

    it("resolves to a sorted subset of TOOL_DOCS names of a size an interactive session can hold", () => {
      const { defaultToolset } = loadToolsets();
      expect(defaultToolset.tools.slice().sort()).toEqual(defaultToolset.tools);
      expect(defaultToolset.tools.filter((name) => !documentedNames.has(name))).toEqual([]);
      expect(defaultToolset.tools.length).toBeGreaterThan(0);
      expect(defaultToolset.tools.length).toBeLessThanOrEqual(60);
    });

    it("equals the union of its group toolsets minus its exclusions plus its inclusions", () => {
      const { toolsets, defaultToolset } = loadToolsets();
      const hand = loadedGroupUnion(toolsets, defaultToolset);
      for (const excluded of Object.keys(defaultToolset.exclusions)) hand.delete(excluded);
      for (const included of Object.keys(defaultToolset.inclusions)) hand.add(included);
      expect(defaultToolset.tools).toEqual([...hand].sort());
    });

    it("gives every exclusion a real tool name from a loaded group and a non-empty reason", () => {
      const { toolsets, defaultToolset } = loadToolsets();
      const loaded = loadedGroupUnion(toolsets, defaultToolset);
      expect(Object.keys(defaultToolset.exclusions).length).toBeGreaterThan(0);
      const offenders = Object.entries(defaultToolset.exclusions).flatMap(([name, reason]) => {
        const problems: string[] = [];
        if (!documentedNames.has(name)) problems.push("not a documented tool");
        // An exclusion outside the loaded groups is a no-op: a stale entry.
        if (!loaded.has(name)) problems.push("not in any loaded group toolset");
        if (typeof reason !== "string" || reason.trim() === "") problems.push("empty reason");
        if (defaultToolset.tools.includes(name)) problems.push("still in the default hand");
        return problems.length === 0 ? [] : [`${name}: ${problems.join(", ")}`];
      });
      expect(offenders).toEqual([]);
    });

    it("gives every inclusion a non-destructive tool from outside the loaded groups and a non-empty reason", () => {
      const surface = loadServerSurface();
      const { toolsets, defaultToolset } = loadToolsets();
      const loaded = loadedGroupUnion(toolsets, defaultToolset);
      expect(Object.keys(defaultToolset.inclusions).length).toBeGreaterThan(0);
      const offenders = Object.entries(defaultToolset.inclusions).flatMap(([name, reason]) => {
        const problems: string[] = [];
        if (!documentedNames.has(name)) problems.push("not a documented tool");
        // An inclusion already inside the loaded groups is a no-op: a stale entry.
        if (loaded.has(name)) problems.push("already in a loaded group toolset");
        if (surface.tools[name]?.annotations.destructiveHint !== false) {
          problems.push("destructive on the wire");
        }
        if (typeof reason !== "string" || reason.trim() === "") problems.push("empty reason");
        if (!defaultToolset.tools.includes(name)) problems.push("missing from the default hand");
        return problems.length === 0 ? [] : [`${name}: ${problems.join(", ")}`];
      });
      expect(offenders).toEqual([]);
    });

    it("keeps the workspace/board-destroying verbs out and every other member non-destructive or explicitly allowed", () => {
      const surface = loadServerSurface();
      const { defaultToolset } = loadToolsets();
      for (const name of NEVER_IN_DEFAULT_HAND) {
        expect(defaultToolset.tools, `${name} must not be in the default hand`).not.toContain(name);
      }
      const offenders = defaultToolset.tools.filter((name) => {
        const wire = surface.tools[name];
        const nonDestructive = wire?.annotations.destructiveHint === false;
        return !(nonDestructive || !NEVER_IN_DEFAULT_HAND.includes(name));
      });
      expect(offenders).toEqual([]);
    });

    it("admits an autonomous-operations tool only when the inclusions table names it", () => {
      const { toolsets, defaultToolset } = loadToolsets();
      const autonomous = toolsets.find(
        ({ kind, id }) => kind === "group" && id === "autonomous-operations",
      );
      expect(autonomous, "no autonomous-operations group toolset").toBeDefined();
      expect(defaultToolset.ids).not.toContain("autonomous-operations");
      const leaked = defaultToolset.tools.filter(
        (name) =>
          autonomous?.tools.includes(name) && !(name in defaultToolset.inclusions),
      );
      expect(leaked).toEqual([]);
    });

    it("keeps the everyday interactive verbs in the hand", () => {
      const { defaultToolset } = loadToolsets();
      for (const name of [
        "get_card",
        "move_card",
        "create_card",
        "get_project_context",
        "search_cards",
      ]) {
        expect(defaultToolset.tools, `${name} missing from the default hand`).toContain(name);
      }
    });
  });
});
