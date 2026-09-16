// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import es from "../locales/es.json";
import ptBr from "../locales/pt-BR.json";

const catalogs = { en, es, "pt-BR": ptBr } as const;

function readPath(catalog: object, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, catalog);
}

describe("operational copy derived from current main", () => {
  it("documents both runnable CLI providers", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const summary = readPath(
        catalog,
        "ui.tooltips.pipelineBuilderLlmProvider.summary",
      );
      expect(summary, locale).toEqual(expect.stringContaining("claude-cli"));
      expect(summary, locale).toEqual(expect.stringContaining("codex-cli"));
    }
  });

  it("does not promise storage deletion or one TTL for every resource URL", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const tooltip = readPath(
        catalog,
        "ui.tooltips.workspace.resources.upload",
      );
      const serialized = JSON.stringify(tooltip);
      expect(serialized, locale).toContain("15");
      expect(serialized, locale).toMatch(/1 (hour|hora)/i);
      expect(serialized, locale).toMatch(/(remain|permanec|permanecem)/i);
      expect(serialized, locale).not.toMatch(/object (soon|shortly)|objeto (GCS )?poco después|pouco depois,? o objeto/i);
    }
  });

  it("describes the current textual tag containment instead of exact matching", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const tooltip = readPath(catalog, "ui.tooltips.workspace.resources.tags");
      const serialized = JSON.stringify(tooltip);
      expect(serialized, locale).toContain("design-system");
      expect(serialized, locale).toContain("design");
      expect(serialized, locale).toMatch(/case-sensitive|sensible a mayúsculas|diferencia maiúsculas/i);
      expect(serialized, locale).not.toMatch(/exact-match|coincidencia exacta|correspondência exata/i);
    }
  });

  it("uses the backend-owned liveness thresholds", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const tooltip = readPath(catalog, "ui.tooltips.runners.table.status");
      const serialized = JSON.stringify(tooltip);
      for (const token of ["90", "600", "alive", "stale", "offline", "unknown"])
        expect(serialized, `${locale}:${token}`).toContain(token);
      expect(serialized, locale).not.toMatch(/5[- ]minute|5 minutos/i);
      expect(serialized, locale).not.toMatch(/frontend heuristic|heurística (del|do) frontend/i);
    }
  });
});
