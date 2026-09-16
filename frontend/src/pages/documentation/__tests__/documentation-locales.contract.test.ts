// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES } from "@/i18n/supported-languages";
import {
  DOCUMENTATION_LOCALES,
  getDocumentationCopy,
} from "../content";
import {
  DOC_GROUPS,
  DOC_SECTIONS,
  getDocGroups,
  getDocSections,
} from "../routes";
import {
  compareDocumentationTranslationKeys,
  getDocumentationSourceStrings,
  getDocumentationCoverage,
  getMissingDocumentationStrings,
  getUnexpectedDocumentationStrings,
  LOCALIZED_SECTION_TRANSLATIONS,
  resolveDocumentationSection,
} from "../section-registry";
import { TOOL_DOCS } from "../mcp-reference/data";
import { MCP_PROMPT_CATALOG_EMPTY_SUMMARY } from "../sections/reference-mcp-prompt-catalog";
import { MCP_TOOL_CATALOG_EMPTY_SUMMARY } from "../sections/reference-mcp-tool-catalog";

describe("documentation locale contract", () => {
  it("versions one local content pack for every supported UI locale", () => {
    expect(Object.keys(DOCUMENTATION_LOCALES)).toEqual(SUPPORTED_LANGUAGES);
    const versions = new Set<string>();

    for (const locale of SUPPORTED_LANGUAGES) {
      const copy = getDocumentationCopy(locale);
      expect(copy.locale).toBe(locale);
      expect(copy.version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
      versions.add(copy.version);
    }

    expect(versions.size).toBe(1);
  });

  it("keeps all 10 groups and 56 stable section slugs in every locale", () => {
    expect(DOC_GROUPS).toHaveLength(10);
    expect(DOC_SECTIONS).toHaveLength(56);

    const expectedGroupIds = DOC_GROUPS.map(({ id }) => id).sort();
    const expectedSlugs = DOC_SECTIONS.map(({ slug }) => slug).sort();

    for (const locale of SUPPORTED_LANGUAGES) {
      const groups = getDocGroups(locale);
      const sections = getDocSections(locale);

      expect(groups.map(({ id }) => id).sort()).toEqual(expectedGroupIds);
      expect(sections.map(({ slug }) => slug).sort()).toEqual(expectedSlugs);
      expect(groups.every(({ title }) => title.trim().length > 0)).toBe(true);
      expect(sections.every(({ title }) => title.trim().length > 0)).toBe(true);

      for (const sourceSection of DOC_SECTIONS) {
        const localized = sections.find(({ slug }) => slug === sourceSection.slug);
        expect(localized).toMatchObject({
          slug: sourceSection.slug,
          group: sourceSection.group,
          order: sourceSection.order,
        });
      }
    }
  });

  it("requires exact group and section title maps for every locale", () => {
    const expectedGroupIds = DOC_GROUPS.map(({ id }) => id).sort();
    const expectedSlugs = DOC_SECTIONS.map(({ slug }) => slug).sort();

    for (const locale of SUPPORTED_LANGUAGES) {
      const copy = getDocumentationCopy(locale);
      expect(Object.keys(copy.groupTitles).sort(), `${locale}: group titles`).toEqual(
        expectedGroupIds,
      );
      expect(Object.keys(copy.sectionTitles).sort(), `${locale}: section titles`).toEqual(
        expectedSlugs,
      );
    }
  });

  it("fails explicitly instead of silently falling back when a localized title is missing", () => {
    const copy = getDocumentationCopy("es");
    const groupTitles = copy.groupTitles as Record<string, string>;
    const sectionTitles = copy.sectionTitles as Record<string, string>;
    const originalGroupTitle = groupTitles.introduction;
    const originalSectionTitle = sectionTitles["what-backplane-is"];

    delete groupTitles.introduction;
    try {
      expect(() => getDocGroups("es")).toThrow(/group title.*introduction/i);
    } finally {
      if (originalGroupTitle !== undefined) {
        groupTitles.introduction = originalGroupTitle;
      }
    }

    delete sectionTitles["what-backplane-is"];
    try {
      expect(() => getDocSections("es")).toThrow(
        /section title.*what-backplane-is/i,
      );
    } finally {
      if (originalSectionTitle !== undefined) {
        sectionTitles["what-backplane-is"] = originalSectionTitle;
      }
    }
  });

  it("registers every localized section explicitly instead of inventing a fallback entry", () => {
    const expectedSlugs = DOC_SECTIONS.map(({ slug }) => slug).sort();

    for (const locale of ["es", "pt-BR"] as const) {
      expect(Object.keys(LOCALIZED_SECTION_TRANSLATIONS[locale]).sort()).toEqual(
        expectedSlugs,
      );
    }
  });

  it("resolves every English slug to its canonical source", () => {
    for (const { slug } of DOC_SECTIONS) {
      const resolved = resolveDocumentationSection("en", slug);
      expect(resolved, `en:${slug} has no source registration`).toBeDefined();
      expect(resolved?.Component).toBeTypeOf("function");
      expect(resolved?.status).toBe("source");
    }
  });

  it("drops partial locale dictionaries when a section falls back to English", () => {
    const slug = "what-backplane-is";
    const translations = LOCALIZED_SECTION_TRANSLATIONS.es as Record<
      string,
      Readonly<Record<string, string>>
    >;
    const original = translations[slug];
    translations[slug] = { "What Backplane Is": "Qué es Backplane" };

    try {
      const resolved = resolveDocumentationSection("es", slug);
      expect(resolved?.status).toBe("fallback");
      expect(resolved?.translations).toEqual({});
    } finally {
      if (original !== undefined) translations[slug] = original;
    }
  });

  it("registers narrative from both empty MCP catalog branches", () => {
    expect(getDocumentationSourceStrings("mcp-tool-catalog")).toContain(
      MCP_TOOL_CATALOG_EMPTY_SUMMARY,
    );
    expect(getDocumentationSourceStrings("mcp-prompt-catalog")).toContain(
      MCP_PROMPT_CATALOG_EMPTY_SUMMARY,
    );
  });

  it("collects lazy MCP narrative while preserving technical identifiers", () => {
    const sources = getDocumentationSourceStrings("mcp-tool-catalog");
    const representativeTool = TOOL_DOCS.find(({ name }) => name === "update_board");
    const doneMergeGate = representativeTool?.params.find(
      ({ name }) => name === "done_merge_gate",
    );

    expect(representativeTool).toBeDefined();
    expect(doneMergeGate).toBeDefined();
    expect(sources).toContain(representativeTool?.description);
    expect(sources).toContain(doneMergeGate?.description);
    expect(sources).toContain("Every tool id follows the ");
    expect(sources).toContain("convention your MCP host uses to invoke it.");
    expect(sources).not.toContain("update_board");
    expect(sources).not.toContain("done_merge_gate");
    expect(sources).not.toContain(representativeTool?.examplePrompt);
  });

  it.each(["es", "pt-BR"] as const)(
    "keeps existing %s MCP mappings stable across additive and reordered sources",
    (locale) => {
      const slug = "mcp-tool-catalog";
      const sources = getDocumentationSourceStrings(slug);
      const translations = LOCALIZED_SECTION_TRANSLATIONS[locale][slug] ?? {};
      const addedSource = "Synthetic additive MCP description.";

      expect(compareDocumentationTranslationKeys(sources, translations)).toEqual({
        missing: [],
        unexpected: [],
      });
      expect(
        compareDocumentationTranslationKeys(
          [addedSource, ...sources.slice().reverse()],
          translations,
        ),
      ).toEqual({ missing: [addedSource], unexpected: [] });
    },
  );

  it("reports an edited source as exactly one missing and one stale key", () => {
    const slug = "mcp-tool-catalog";
    const sources = getDocumentationSourceStrings(slug);
    const translations = LOCALIZED_SECTION_TRANSLATIONS.es[slug] ?? {};
    const original = sources[0];
    if (original === undefined) throw new Error("MCP source catalog is empty");
    const edited = `${original} (edited)`;

    expect(
      compareDocumentationTranslationKeys(
        sources.map((source) => (source === original ? edited : source)),
        translations,
      ),
    ).toEqual({ missing: [edited], unexpected: [original] });
  });

  it("rejects blank translations and collapses repeated exact source strings", () => {
    expect(
      compareDocumentationTranslationKeys(["Repeated", "Repeated"], {
        Repeated: "   ",
      }),
    ).toEqual({ missing: ["Repeated"], unexpected: [] });
  });

  it.each(["es", "pt-BR"] as const)(
    "requires explicit narrative for every %s section",
    (locale) => {
      const incomplete = DOC_SECTIONS.flatMap(({ slug }) => {
        const missing = getMissingDocumentationStrings(locale, slug);
        const unexpected = getUnexpectedDocumentationStrings(locale, slug);
        const resolved = resolveDocumentationSection(locale, slug);
        expect(resolved, `${locale}:${slug} has no content registration`).toBeDefined();
        expect(resolved?.Component).toBeTypeOf("function");

        return missing.length === 0 && unexpected.length === 0
          ? []
          : [
              {
                slug,
                missingNarrativeStrings: missing.length,
                unexpectedNarrativeStrings: unexpected.length,
              },
            ];
      });

      expect(incomplete).toEqual([]);
    },
  );

  it("reports canonical English coverage", () => {
    expect(getDocumentationCoverage("en")).toEqual({
      source: 56,
      translated: 0,
      fallback: 0,
      total: 56,
    });
  });

  it.each(["es", "pt-BR"] as const)(
    "reports 56/56 translated coverage for %s without fallback",
    (locale) => {
      expect(getDocumentationCoverage(locale)).toEqual({
        source: 0,
        translated: 56,
        fallback: 0,
        total: 56,
      });
    },
  );
});
