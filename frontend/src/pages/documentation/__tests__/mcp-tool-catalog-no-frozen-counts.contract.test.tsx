// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ES_SECTION_TRANSLATIONS } from "../content/sections/es";
import { PT_BR_SECTION_TRANSLATIONS } from "../content/sections/pt-BR";
import { CATEGORIES, TOOL_DOCS } from "../mcp-reference/data";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import {
  getDocumentationSourceStrings,
  getMissingDocumentationStrings,
  getUnexpectedDocumentationStrings,
  resolveDocumentationSection,
} from "../section-registry";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

// Section translations key on the exact English source string. A summary
// that interpolates live counts into ONE string therefore mints a new key
// every time a tool is added, the es/pt-BR map misses it, and the registry
// downgrades the WHOLE section to English fallback. Counts must be rendered
// as separate children so the translatable fragments carry no digits.
const SLUG = "mcp-tool-catalog";
const LOCALIZED_LOCALES = ["es", "pt-BR"] as const;

const FROZEN_TOOL_COUNT = /\d+\s+(tools|herramientas|ferramentas)\b/i;
const FROZEN_CATEGORY_COUNT = /\d+\s+categor(ies|ías|ias)\b/i;
// Digit within a short window AFTER the noun, e.g. "herramientas en 26" — the
// shape a translator produces when the target language orders count last.
const TRAILING_COUNT =
  /\b(tools|herramientas|ferramentas|categor(?:ies|ías|ias))\b[^\d\n]{0,30}\d+/i;

const TRANSLATION_MAPS = {
  es: ES_SECTION_TRANSLATIONS[SLUG],
  "pt-BR": PT_BR_SECTION_TRANSLATIONS[SLUG],
} as const;

const EXPECTED_TOOL_COUNT = TOOL_DOCS.length;
const EXPECTED_CATEGORY_COUNT = Math.min(
  new Set(TOOL_DOCS.map((doc) => doc.category)).size,
  CATEGORIES.length,
);

const LOCALIZED_SUMMARY_PHRASE = {
  es: `${EXPECTED_TOOL_COUNT} herramientas en ${EXPECTED_CATEGORY_COUNT} categorías`,
  "pt-BR": `${EXPECTED_TOOL_COUNT} ferramentas em ${EXPECTED_CATEGORY_COUNT} categorias`,
} as const;

function hasFrozenCount(value: string) {
  return (
    FROZEN_TOOL_COUNT.test(value) ||
    FROZEN_CATEGORY_COUNT.test(value) ||
    TRAILING_COUNT.test(value)
  );
}

function renderLocalizedSectionText(locale: (typeof LOCALIZED_LOCALES)[number]) {
  const resolved = resolveDocumentationSection(locale, SLUG);
  if (!resolved) throw new Error(`Missing documentation section: ${locale}:${SLUG}`);
  const Component = resolved.Component;
  const view = render(
    <MemoryRouter initialEntries={[`/documentation/${SLUG}`]}>
      <DocumentationSectionTranslationProvider translations={resolved.translations}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  return {
    status: resolved.status,
    text: (view.container.textContent ?? "").replace(/\s+/g, " "),
  };
}

afterEach(cleanup);

describe("MCP Tool Catalog summary carries no frozen counts", () => {
  it("emits no translatable source string with a numeral glued to tools/categories", () => {
    const offenders = getDocumentationSourceStrings(SLUG).filter(hasFrozenCount);
    expect(offenders).toEqual([]);
  });

  it.each(LOCALIZED_LOCALES)(
    "%s translation map has no key or value with a numeral glued to tools/categories",
    (locale) => {
      const map = TRANSLATION_MAPS[locale];
      expect(map, `${locale} has no ${SLUG} translation map`).toBeDefined();
      const offenders = Object.entries(map).flatMap(([source, localized]) => [
        ...(hasFrozenCount(source) ? [{ locale, side: "key", text: source }] : []),
        ...(hasFrozenCount(localized) ? [{ locale, side: "value", text: localized }] : []),
      ]);
      expect(offenders).toEqual([]);
    },
  );

  // Also pinned by documentation-locales.contract.test.ts for every section;
  // repeated here because parity loss on this slug IS the regression of this
  // card: one missed key sends the whole catalog page back to English.
  it.each(LOCALIZED_LOCALES)("%s keeps exact key parity for the catalog section", (locale) => {
    expect(getMissingDocumentationStrings(locale, SLUG)).toEqual([]);
    expect(getUnexpectedDocumentationStrings(locale, SLUG)).toEqual([]);
    expect(resolveDocumentationSection(locale, SLUG)?.status).toBe("translated");
  });

  it.each(LOCALIZED_LOCALES)(
    "%s renders the summary with live counts inside translated copy",
    (locale) => {
      const { status, text } = renderLocalizedSectionText(locale);
      expect(status).toBe("translated");
      expect(text).toContain(LOCALIZED_SUMMARY_PHRASE[locale]);
      expect(text).not.toContain(`${EXPECTED_TOOL_COUNT} tools across`);
    },
  );

  describe("detector self-check", () => {
    it.each([
      "145 tools across 26 categories — searchable, filterable, and copy-ready. ",
      "145 tools",
      "145 herramientas en 26 categorías: se pueden buscar, filtrar y copiar. ",
      "145 ferramentas em 26 categorias — pesquisáveis, filtráveis e prontas para copiar. ",
      "26 categories",
      "26 categorías",
      "26 categorias",
      " herramientas en 26 ",
      " ferramentas em 26 ",
      " tools across 26 ",
    ])("flags %j", (sample) => {
      expect(hasFrozenCount(sample)).toBe(true);
    });

    it.each([
      " tools across ",
      " categories — searchable, filterable, and copy-ready. ",
      " herramientas en ",
      " categorías: se pueden buscar, filtrar y copiar. ",
      " ferramentas em ",
      " categorias — pesquisáveis, filtráveis e prontas para copiar. ",
      "Searchable, filterable, copy-ready. ",
    ])("allows %j", (sample) => {
      expect(hasFrozenCount(sample)).toBe(false);
    });
  });
});
