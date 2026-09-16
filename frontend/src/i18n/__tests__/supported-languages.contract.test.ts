// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import en from "../locales/en.json";
import es from "../locales/es.json";
import ptBr from "../locales/pt-BR.json";

type LocaleRegistryEntry = {
  code: string;
  label: string;
  translation: Record<string, unknown>;
};

type SupportedLanguagesModule = {
  LOCALE_REGISTRY: readonly LocaleRegistryEntry[];
  SUPPORTED_LANGUAGES: readonly string[];
};

const expectedCatalogs = {
  en,
  es,
  "pt-BR": ptBr,
} as const;

const supportedLanguagesPath = resolve(
  process.cwd(),
  "src/i18n/supported-languages.ts",
);
const configPath = resolve(process.cwd(), "src/i18n/config.ts");
const languageSwitcherPath = resolve(
  process.cwd(),
  "src/components/LanguageSwitcher.tsx",
);

async function loadSupportedLanguagesModule() {
  if (!existsSync(supportedLanguagesPath)) {
    expect.fail(
      "Missing src/i18n/supported-languages.ts: locales still have no shared runtime registry",
    );
  }

  const [metadata, registry] = await Promise.all([
    vi.importActual<Omit<SupportedLanguagesModule, "LOCALE_REGISTRY">>(
      "../supported-languages",
    ),
    vi.importActual<Pick<SupportedLanguagesModule, "LOCALE_REGISTRY">>(
      "../locale-registry",
    ),
  ]);
  return { ...metadata, ...registry };
}

describe("supported language registry contract", () => {
  it("is the single source used by i18next and the language switcher", async () => {
    const { LOCALE_REGISTRY, SUPPORTED_LANGUAGES } =
      await loadSupportedLanguagesModule();
    const expectedCodes = Object.keys(expectedCatalogs);

    expect(LOCALE_REGISTRY).toBeInstanceOf(Array);
    expect(LOCALE_REGISTRY.map(({ code }) => code)).toEqual(expectedCodes);
    expect(SUPPORTED_LANGUAGES).toEqual(expectedCodes);

    for (const entry of LOCALE_REGISTRY) {
      expect(entry.label.trim(), `${entry.code} has an empty selector label`).not.toBe(
        "",
      );
      expect(
        entry.translation,
        `${entry.code} does not expose its catalog through LOCALE_REGISTRY`,
      ).toEqual(expectedCatalogs[entry.code as keyof typeof expectedCatalogs]);
    }

    const configSource = readFileSync(configPath, "utf8");
    const switcherSource = readFileSync(languageSwitcherPath, "utf8");

    expect(configSource).toMatch(/from ["']\.\/supported-languages["']/);
    expect(switcherSource).toMatch(
      /from ["']@\/i18n\/supported-languages["']/,
    );
    expect(switcherSource).not.toMatch(/const\s+LANGUAGES\s*=/);

    vi.resetModules();
    const { default: i18n } = await import("../config");
    // Non-English catalogs load on demand (they are not in the entry chunk), so
    // reachability is asserted through the switcher's own seam — changeLanguage
    // — rather than by expecting every bundle to be preloaded at boot.
    for (const { code, translation } of LOCALE_REGISTRY) {
      await i18n.changeLanguage(code);
      expect(i18n.hasResourceBundle(code, "translation")).toBe(true);
      expect(i18n.getResourceBundle(code, "translation")).toEqual(translation);
    }
  });
});
