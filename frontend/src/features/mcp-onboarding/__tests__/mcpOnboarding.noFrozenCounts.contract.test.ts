// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBR from "@/i18n/locales/pt-BR.json";

// Launch rule: no frozen tool/category counts in public material. The MCP
// surface grows every release, so any literal "<n> tools" in wizard copy is
// stale the moment it ships. This walks every string leaf under mcpOnboarding
// in every locale and rejects numerals glued to the tool/category nouns.
//
// `\d+\s+` requires a literal digit run, so an i18next placeholder like
// "{{count}} tools" passes: interpolated counts are live, not frozen.
const FROZEN_TOOL_COUNT = /\d+\+?\s+((platform|MCP)\s+)?(tools|herramientas|ferramentas)\b/i;
const FROZEN_CATEGORY_COUNT = /\d+\s+(categories|categorías|categorias)\b/i;

type LocaleId = "en" | "es" | "pt-BR";

const LOCALES: Record<LocaleId, Record<string, unknown>> = {
  en: en as Record<string, unknown>,
  es: es as Record<string, unknown>,
  "pt-BR": ptBR as Record<string, unknown>,
};

const KEYS_THAT_MUST_SURVIVE = ["introBody", "verifyNextDocsBody"];

type Offender = { locale: string; key: string; value: string };

function collectStringLeaves(
  node: unknown,
  path: string,
  out: Array<{ key: string; value: string }>,
): void {
  if (typeof node === "string") {
    out.push({ key: path, value: node });
    return;
  }
  if (node && typeof node === "object") {
    for (const [segment, child] of Object.entries(node)) {
      collectStringLeaves(child, `${path}.${segment}`, out);
    }
  }
}

function mcpOnboardingSection(locale: LocaleId): Record<string, unknown> {
  return LOCALES[locale].mcpOnboarding as Record<string, unknown>;
}

describe("mcpOnboarding copy carries no frozen tool/category counts", () => {
  it("has an mcpOnboarding namespace in every locale", () => {
    for (const locale of Object.keys(LOCALES) as LocaleId[]) {
      expect(
        mcpOnboardingSection(locale),
        `${locale} missing mcpOnboarding namespace`,
      ).toBeTypeOf("object");
    }
  });

  it("has no numeral glued to tools/categories in any string leaf of any locale", () => {
    const offenders: Offender[] = [];
    for (const locale of Object.keys(LOCALES) as LocaleId[]) {
      const leaves: Array<{ key: string; value: string }> = [];
      collectStringLeaves(mcpOnboardingSection(locale), "mcpOnboarding", leaves);
      expect(leaves.length, `${locale} mcpOnboarding has no strings`).toBeGreaterThan(0);
      for (const { key, value } of leaves) {
        if (FROZEN_TOOL_COUNT.test(value) || FROZEN_CATEGORY_COUNT.test(value)) {
          offenders.push({ locale, key, value });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The fix is to drop the numbers, not the copy. Deleting these keys would
  // make the walk pass while shipping an i18next fallback to the raw key.
  it.each(KEYS_THAT_MUST_SURVIVE)(
    "keeps mcpOnboarding.%s as a non-empty string in every locale",
    (key) => {
      for (const locale of Object.keys(LOCALES) as LocaleId[]) {
        const value = mcpOnboardingSection(locale)[key];
        expect(value, `${locale} missing mcpOnboarding.${key}`).toBeTypeOf("string");
        expect((value as string).trim().length, `${locale} mcpOnboarding.${key} is empty`).toBeGreaterThan(0);
      }
    },
  );

  describe("detector self-check", () => {
    it.each([
      "119 platform tools",
      "Backplane exposes 119 platform tools across",
      "119 tools",
      "Browse all 119 tools",
      "119 herramientas",
      "119 ferramentas",
      "119+ tools",
      "119 MCP tools",
    ])("flags frozen tool count %j", (sample) => {
      expect(FROZEN_TOOL_COUNT.test(sample)).toBe(true);
    });

    it.each(["24 categories", "24 categorías", "24 categorias"])(
      "flags frozen category count %j",
      (sample) => {
        expect(FROZEN_CATEGORY_COUNT.test(sample)).toBe(true);
      },
    );

    it.each([
      "dozens of tools",
      "{{count}} tools",
      "{{count}} categories",
      "tools across categories",
      "herramientas de la plataforma",
    ])("allows %j", (sample) => {
      expect(FROZEN_TOOL_COUNT.test(sample)).toBe(false);
      expect(FROZEN_CATEGORY_COUNT.test(sample)).toBe(false);
    });
  });
});
