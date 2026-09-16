// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SupportedLanguage } from "@/i18n/supported-languages";
import { DOC_SECTIONS } from "../routes";
import { resolveDocumentationSection } from "../section-registry";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import {
  collectDocumentationTechnicalContract,
  compareDocumentationTechnicalContracts,
} from "../technical-contract";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

const LOCALIZED_DOCUMENTATION_LOCALES = ["es", "pt-BR"] as const;

function renderSection(locale: SupportedLanguage, slug: string) {
  const resolved = resolveDocumentationSection(locale, slug);
  if (!resolved) throw new Error(`Missing documentation section: ${locale}:${slug}`);
  const Component = resolved.Component;

  return render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider
        translations={resolved.translations}
      >
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
}

describe("documentation section technical parity", () => {
  it.each(DOC_SECTIONS.map(({ slug }) => [slug] as const))(
    "keeps anchors, code, links and technical tokens stable for %s",
    (slug) => {
      const source = renderSection("en", slug);
      const sourceContract = collectDocumentationTechnicalContract(
        source.container,
      );
      cleanup();

      for (const locale of LOCALIZED_DOCUMENTATION_LOCALES) {
        const localized = renderSection(locale, slug);
        const localizedContract = collectDocumentationTechnicalContract(
          localized.container,
        );

        expect(
          compareDocumentationTechnicalContracts(
            sourceContract,
            localizedContract,
          ),
          `${locale}:${slug} changed the English technical contract`,
        ).toEqual([]);
        cleanup();
      }
    },
  );
});
