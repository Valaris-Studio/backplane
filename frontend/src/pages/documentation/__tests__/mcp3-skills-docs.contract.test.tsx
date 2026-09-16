// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SupportedLanguage } from "@/i18n/supported-languages";
import { ES_SECTION_TRANSLATIONS } from "../content/sections/es";
import { PT_BR_SECTION_TRANSLATIONS } from "../content/sections/pt-BR";
import { DOC_SECTIONS } from "../routes";
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

// MCP #3 — the Core Concepts › Skills section documents the one frontmatter
// key Backplane defines beyond name/description: `toolsets:` (the hand a skill
// plays in), and carries a short subsection "Toolsets enforce, skills guide"
// explaining that a skill can never scope a client's tool listing — the
// toolset is what the server lists and allows, the skill only declares the
// hand it was written for, and the platform warns when prose and hand
// disagree. The MCP Toolsets reference cross-links to it.
const SKILLS_SLUG = "skills";
const TOOLSETS_SLUG = "mcp-toolsets";
const LOCALIZED_LOCALES = ["es", "pt-BR"] as const;
const SUBSECTION_HEADING = /toolsets enforce, skills guide/i;

// Same detectors as mcp-toolsets-section.contract.test.tsx: a numeral glued to
// tools/categories inside narrative would mint a new translation key on every
// server release.
const FROZEN_TOOL_COUNT = /\d+\s+(tools|herramientas|ferramentas)\b/i;
const FROZEN_CATEGORY_COUNT = /\d+\s+categor(ies|ías|ias)\b/i;
const TRAILING_COUNT =
  /\b(tools|herramientas|ferramentas|categor(?:ies|ías|ias))\b[^\d\n]{0,30}\d+/i;

function hasFrozenCount(value: string) {
  return (
    FROZEN_TOOL_COUNT.test(value) ||
    FROZEN_CATEGORY_COUNT.test(value) ||
    TRAILING_COUNT.test(value)
  );
}

const TRANSLATION_MAPS = {
  es: ES_SECTION_TRANSLATIONS[SKILLS_SLUG],
  "pt-BR": PT_BR_SECTION_TRANSLATIONS[SKILLS_SLUG],
} as const;

function renderSection(locale: SupportedLanguage, slug: string) {
  const resolved = resolveDocumentationSection(locale, slug);
  if (!resolved) throw new Error(`Missing documentation section: ${locale}:${slug}`);
  const Component = resolved.Component;
  const view = render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider translations={resolved.translations}>
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  return {
    status: resolved.status,
    container: view.container,
    text: (view.container.textContent ?? "").replace(/\s+/g, " "),
  };
}

function headingTexts(container: HTMLElement) {
  return [...container.querySelectorAll("h2, h3")].map(
    (node) => (node.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

afterEach(cleanup);

describe("Core Concepts › Skills — toolset declarations (MCP #3)", () => {
  it("is still the core-concepts section at slug 'skills'", () => {
    expect(DOC_SECTIONS).toContainEqual(
      expect.objectContaining({ slug: SKILLS_SLUG, group: "core-concepts" }),
    );
  });

  describe("rendered content (en)", () => {
    it("documents the toolsets: frontmatter key in the narrative and the example", () => {
      const { text, container } = renderSection("en", SKILLS_SLUG);
      expect(text).toContain("toolsets:");
      // The minimal SKILL.md example carries the key so a reader can copy it.
      const examples = [...container.querySelectorAll("pre, code")].map(
        (node) => node.textContent ?? "",
      );
      expect(examples.some((example) => /^\s*toolsets:/m.test(example))).toBe(true);
    });

    it("carries a 'Toolsets enforce, skills guide' subsection", () => {
      const { container } = renderSection("en", SKILLS_SLUG);
      expect(headingTexts(container).some((h) => SUBSECTION_HEADING.test(h))).toBe(
        true,
      );
    });

    it("says the declaration is validated at store time and read from SKILL.md on every serve", () => {
      const { text } = renderSection("en", SKILLS_SLUG);
      // Derived at read time, never persisted as a column: the old "read when a
      // version is stored" phrasing implied a stored copy.
      expect(text).toContain("validated when a version is stored");
      expect(text).toContain("read from SKILL.md whenever the skill is served");
      expect(text).not.toContain("read by the backend when a version is stored");
    });

    it("explains that a skill cannot scope a client's listing — the toolset does", () => {
      const { text } = renderSection("en", SKILLS_SLUG);
      expect(text).toMatch(/cannot|never|does not/i);
      expect(text).toMatch(/lists|listing/i);
      expect(text).toMatch(/warn/i);
    });
  });

  describe("localization", () => {
    it.each(LOCALIZED_LOCALES)("resolves %s as fully translated", (locale) => {
      expect(getMissingDocumentationStrings(locale, SKILLS_SLUG)).toEqual([]);
      expect(getUnexpectedDocumentationStrings(locale, SKILLS_SLUG)).toEqual([]);
      expect(resolveDocumentationSection(locale, SKILLS_SLUG)?.status).toBe(
        "translated",
      );
    });

    it.each(LOCALIZED_LOCALES)(
      "renders the %s subsection heading translated, not as the English source",
      (locale) => {
        const englishHeading = headingTexts(
          renderSection("en", SKILLS_SLUG).container,
        ).find((h) => SUBSECTION_HEADING.test(h));
        expect(englishHeading).toBeDefined();
        cleanup();

        const localizedHeadings = headingTexts(
          renderSection(locale, SKILLS_SLUG).container,
        );
        expect(localizedHeadings).not.toContain(englishHeading);
        expect(localizedHeadings.some((h) => /toolsets?/i.test(h))).toBe(true);
      },
    );

    it("keeps numerals out of the English source strings", () => {
      const offenders = getDocumentationSourceStrings(SKILLS_SLUG).filter(hasFrozenCount);
      expect(offenders).toEqual([]);
    });

    it.each(LOCALIZED_LOCALES)(
      "keeps numerals out of the %s translation map keys and values",
      (locale) => {
        const map = TRANSLATION_MAPS[locale];
        expect(map, `${locale} has no ${SKILLS_SLUG} translation map`).toBeDefined();
        const offenders = Object.entries(map ?? {}).flatMap(([source, localized]) => [
          ...(hasFrozenCount(source) ? [{ locale, side: "key", text: source }] : []),
          ...(hasFrozenCount(localized) ? [{ locale, side: "value", text: localized }] : []),
        ]);
        expect(offenders).toEqual([]);
      },
    );
  });
});

describe("Reference › MCP Toolsets — cross-link to skills (MCP #3)", () => {
  it("links to the skills section", () => {
    const { container } = renderSection("en", TOOLSETS_SLUG);
    const hrefs = [...container.querySelectorAll("a[href]")].map(
      (node) => node.getAttribute("href") ?? "",
    );
    expect(hrefs.some((href) => /\/documentation\/skills$/.test(href))).toBe(true);
  });
});
