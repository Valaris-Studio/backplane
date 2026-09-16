// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ES_SECTION_TRANSLATIONS } from "../content/sections/es";
import { PT_BR_SECTION_TRANSLATIONS } from "../content/sections/pt-BR";
import { PROMPT_DOCS } from "../mcp-reference/data";
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

// Sibling of the tool-catalog contract: section translations key on the exact
// English source string, so "<n> prompts total" as ONE string mints a new key
// on the next prompt added, the es/pt-BR map misses it, and the registry
// downgrades the WHOLE section to English fallback. The count must be its own
// child so the translatable fragment carries no digits.
const SLUG = "mcp-prompt-catalog";
const LOCALIZED_LOCALES = ["es", "pt-BR"] as const;

const LEADING_PROMPT_COUNT = /\d+\s+prompts\b/i;
// Digit within a short window AFTER the noun, e.g. "prompts en 10" — the
// shape a translator produces when the target language orders count last.
const TRAILING_PROMPT_COUNT = /\bprompts\b[^\d\n]{0,30}\d+/i;

const TRANSLATION_MAPS = {
  es: ES_SECTION_TRANSLATIONS[SLUG],
  "pt-BR": PT_BR_SECTION_TRANSLATIONS[SLUG],
} as const;

const EXPECTED_PROMPT_COUNT = PROMPT_DOCS.length;

const LOCALIZED_SUMMARY_PHRASE = {
  es: `${EXPECTED_PROMPT_COUNT} prompts, organizados por rol. `,
  "pt-BR": `${EXPECTED_PROMPT_COUNT} prompts no total, organizados por função de agente. `,
} as const;

function hasFrozenCount(value: string) {
  return LEADING_PROMPT_COUNT.test(value) || TRAILING_PROMPT_COUNT.test(value);
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

describe("MCP Prompt Catalog summary carries no frozen count", () => {
  it("emits no translatable source string with a numeral glued to prompts", () => {
    const offenders = getDocumentationSourceStrings(SLUG).filter(hasFrozenCount);
    expect(offenders).toEqual([]);
  });

  it.each(LOCALIZED_LOCALES)(
    "%s translation map has no key or value with a numeral glued to prompts",
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
  // card: one missed key sends the whole prompt catalog page back to English.
  it.each(LOCALIZED_LOCALES)("%s keeps exact key parity for the prompt catalog section", (locale) => {
    expect(getMissingDocumentationStrings(locale, SLUG)).toEqual([]);
    expect(getUnexpectedDocumentationStrings(locale, SLUG)).toEqual([]);
    expect(resolveDocumentationSection(locale, SLUG)?.status).toBe("translated");
  });

  it.each(LOCALIZED_LOCALES)(
    "%s renders the summary with the live count inside translated copy",
    (locale) => {
      const { status, text } = renderLocalizedSectionText(locale);
      expect(status).toBe("translated");
      expect(text).toContain(LOCALIZED_SUMMARY_PHRASE[locale]);
      expect(text).not.toContain(`${EXPECTED_PROMPT_COUNT} prompts total`);
    },
  );

  describe("detector self-check", () => {
    it.each([
      "10 prompts total, organized by agent role. ",
      "10 prompts, organizados por rol. ",
      "10 prompts no total, organizados por função de agente. ",
      "10 prompts",
      "prompts total 10",
      " prompts en total: 10 ",
      " prompts, organizados por rol: 10 ",
    ])("flags %j", (sample) => {
      expect(hasFrozenCount(sample)).toBe(true);
    });

    it.each([
      " prompts total, organized by agent role. ",
      " prompts, organizados por rol. ",
      " prompts no total, organizados por função de agente. ",
      "Prompts are organized by agent role. ",
      "Other prompts can present a plan and then proceed without a second confirmation gate.",
    ])("allows %j", (sample) => {
      expect(hasFrozenCount(sample)).toBe(false);
    });
  });
});
