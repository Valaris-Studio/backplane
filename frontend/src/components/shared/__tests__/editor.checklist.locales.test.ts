// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";

// The checkbox label is read by screen readers on every task item, so an
// English fallback in es/pt-BR is an accessibility regression, not cosmetics.
const CHECKLIST_KEYS = ["editor.taskList", "editor.taskItemCheckbox", "editor.taskItemEmpty"];

function lookup(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined,
      catalog,
    );
}

describe("editor checklist i18n", () => {
  it.each(CHECKLIST_KEYS)("defines %s in en, es and pt-BR, translated", (key) => {
    expect(typeof lookup(en, key)).toBe("string");
    for (const catalog of [es, ptBr]) {
      expect(typeof lookup(catalog, key)).toBe("string");
      expect(lookup(catalog, key)).not.toBe(lookup(en, key));
    }
  });

  it("interpolates the item text into the checkbox label", () => {
    for (const catalog of [en, es, ptBr]) {
      expect(lookup(catalog, "editor.taskItemCheckbox")).toContain("{{text}}");
    }
  });
});
