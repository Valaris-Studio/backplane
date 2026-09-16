// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// "runner" is the credentialed process; "coding agent" is Claude Code/Codex.
// "runner agent" doubles the two and is banned from the MCP reference copy
// (model voice: runner/docs/providers.md). Mirrors DOUBLED_TERM in
// mcp-server/tests/test_vocabulary_contract.py.
const DOUBLED_TERM = /\brunner[- ]agents?\b/i;

const FRONTEND_ROOT = process.cwd();
const MCP_REFERENCE_DATA_DIR = resolve(
  FRONTEND_ROOT,
  "src/pages/documentation/mcp-reference/data",
);
const EXTRA_SWEPT_FILES = [
  "src/pages/documentation/sections/reference-mcp-tool-catalog.tsx",
  "src/features/agents/lib/toolCatalog.ts",
].map((path) => resolve(FRONTEND_ROOT, path));
const LOCALE_REFERENCE_MAPS = [
  "src/pages/documentation/content/sections/es/reference.ts",
  "src/pages/documentation/content/sections/pt-BR/reference.ts",
].map((path) => resolve(FRONTEND_ROOT, path));

function mcpReferenceDataFiles(): string[] {
  return readdirSync(MCP_REFERENCE_DATA_DIR)
    .filter((entry) => entry.endsWith(".ts"))
    .sort()
    .map((entry) => resolve(MCP_REFERENCE_DATA_DIR, entry));
}

function doubledTermOffenders(paths: string[]): string[] {
  return paths.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        DOUBLED_TERM.test(line)
          ? [`${relative(FRONTEND_ROOT, path)}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );
}

describe("MCP reference vocabulary contract", () => {
  it("sweeps every module that data/index.ts re-exports", () => {
    const swept = new Set(
      mcpReferenceDataFiles().map((path) => relative(MCP_REFERENCE_DATA_DIR, path)),
    );
    const reExported = [
      ...readFileSync(resolve(MCP_REFERENCE_DATA_DIR, "index.ts"), "utf8").matchAll(
        /from\s+"\.\/([\w-]+)"/g,
      ),
    ].map((match) => `${match[1]}.ts`);

    expect(reExported.length).toBeGreaterThan(0);
    expect(reExported.filter((name) => !swept.has(name))).toEqual([]);
    expect(swept.has("categories.ts")).toBe(true);
  });

  it("never says 'runner agent' in the mcp-reference data, the catalog section, or toolCatalog.ts", () => {
    const offenders = doubledTermOffenders([
      ...mcpReferenceDataFiles(),
      ...EXTRA_SWEPT_FILES,
    ]);

    expect(offenders).toEqual([]);
  });

  it("never says 'runner agent' in the es or pt-BR reference maps (keys or values)", () => {
    const offenders = doubledTermOffenders(LOCALE_REFERENCE_MAPS);

    expect(offenders).toEqual([]);
  });
});
