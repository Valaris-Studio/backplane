// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

// The mermaid NodeView adds four user-facing strings (editor P1-3). i18next
// silently falls back to English on a missing key, so a half-finished catalog
// ships as English-in-Spanish rather than failing loudly — this is the guard.
const MERMAID_KEYS = [
  "editor.mermaid",
  "editor.mermaidEdit",
  "editor.mermaidError",
  "editor.mermaidLoading",
];

function lookup(catalog: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, seg) =>
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[seg]
          : undefined,
      catalog,
    );
}

describe("editor mermaid i18n parity", () => {
  it.each(MERMAID_KEYS)("defines %s in both en and es", (key) => {
    expect(typeof lookup(en, key)).toBe("string");
    expect(typeof lookup(es, key)).toBe("string");
  });

  it("translated the strings rather than copying the English", () => {
    // All four are prose, not technical identifiers — an identical es value
    // means the key was pasted in untranslated.
    for (const key of MERMAID_KEYS) {
      expect(lookup(es, key)).not.toBe(lookup(en, key));
    }
  });
});
