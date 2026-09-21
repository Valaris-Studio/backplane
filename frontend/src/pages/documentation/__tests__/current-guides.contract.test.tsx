// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SUPPORTED_LANGUAGES } from "@/i18n/supported-languages";
import { exportDocumentation } from "../agent-export";
import { DOC_SECTIONS } from "../routes";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import { resolveDocumentationSection } from "../section-registry";

vi.mock("@/hooks/use-reduced-motion", () => ({ useReducedMotion: () => true }));
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => true }));

describe("current product guides", () => {
  it("renders every guide without unfinished screenshot frames in every locale", () => {
    for (const locale of SUPPORTED_LANGUAGES) {
      for (const { slug } of DOC_SECTIONS) {
        const resolved = resolveDocumentationSection(locale, slug)!;
        const Component = resolved.Component;
        const html = renderToStaticMarkup(
          <MemoryRouter>
            <DocumentationSectionTranslationProvider translations={resolved.translations}>
              <Component />
            </DocumentationSectionTranslationProvider>
          </MemoryRouter>,
        );

        expect(html, `${locale}:${slug}`).not.toContain("data-screenshot-frame");
      }
    }
  });

  it("exports finished guides and the supported runner providers in every locale", async () => {
    const corpus = await exportDocumentation();
    for (const locale of SUPPORTED_LANGUAGES) {
      for (const section of corpus.locales[locale]!) {
        expect(section.status, `${locale}:${section.slug}`).toBe(
          locale === "en" ? "source" : "translated",
        );
        expect(section.markdown, `${locale}:${section.slug}`).not.toContain("[SCREENSHOT]");
      }
      for (const slug of ["what-backplane-is", "what-it-is-not", "quick-tour"]) {
        const guide = corpus.locales[locale]!.find((section) => section.slug === slug)!;
        expect(guide.markdown, `${locale}:${slug}`).toContain("Claude Code");
        expect(guide.markdown, `${locale}:${slug}`).toContain("Codex CLI");
      }
    }
  }, 30000);
});
