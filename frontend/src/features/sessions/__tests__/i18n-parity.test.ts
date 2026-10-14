// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";

type Catalog = Record<string, unknown>;

function leafKeys(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object") return [prefix];
  return Object.entries(node as Catalog).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

// es and pt-BR also need CLDR's `many` category, so compare plural stems.
function stems(keys: string[]): string[] {
  return [...new Set(keys.map((key) => key.replace(/_(zero|one|two|few|many|other)$/, "_<plural>")))].sort();
}

function interpolations(catalog: Catalog, key: string): string[] {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Catalog)?.[part], catalog);
  return typeof value === "string" ? (value.match(/\{\{[^}]+\}\}/g) ?? []).sort() : [];
}

const locales: Record<string, Catalog> = { es: es as Catalog, "pt-BR": ptBr as Catalog };
const englishSessionKeys = leafKeys((en as Catalog).sessions, "sessions").sort();

describe("sessions copy parity", () => {
  for (const [code, catalog] of Object.entries({ en: en as Catalog, ...locales })) {
    it(`${code} provides localized excerpt actions and incomplete-export explanations`, () => {
      const contents = (catalog.sessions as Catalog).contents as Catalog;
      const excerpt = contents.excerpt as Catalog | undefined;
      expect(excerpt, `sessions.contents.excerpt in ${code}`).toBeDefined();
      for (const key of ["preview", "title", "previewLabel", "copy", "download", "cancel", "moreItems", "excludedAttachments", "tooLarge", "failed"]) {
        expect(excerpt?.[key], `${code} excerpt.${key}`).toEqual(expect.any(String));
        expect((excerpt?.[key] as string | undefined)?.trim()).not.toBe("");
        if (code !== "en") {
          const english = ((en as Catalog).sessions as Catalog).contents as Catalog;
          expect(excerpt?.[key], `${code} excerpt.${key} is translated`).not.toBe((english.excerpt as Catalog | undefined)?.[key]);
        }
      }
    });
  }

  it("has a sessions namespace and the sidebar label in English", () => {
    expect(englishSessionKeys.length).toBeGreaterThan(50);
    expect((en as { nav: Catalog }).nav.sessions).toBe("My sessions");
  });

  for (const [code, catalog] of Object.entries(locales)) {
    it(`${code} carries exactly the English sessions keys`, () => {
      expect(stems(leafKeys(catalog.sessions, "sessions"))).toEqual(stems(englishSessionKeys));
      expect((catalog as { nav: Catalog }).nav.sessions).toEqual(expect.any(String));
    });

    it(`${code} keeps every interpolation placeholder`, () => {
      // A singular form may spell the number out, so `_one` is exempt.
      const drift = englishSessionKeys
        .filter((key) => !key.endsWith("_one"))
        .filter((key) => interpolations(catalog, key).join() !== interpolations(en as Catalog, key).join());
      expect(drift).toEqual([]);
    });
  }
});
