// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ES_CONFIGURATION } from "../content/sections/es/configuration";
import { PT_BR_CONFIGURATION } from "../content/sections/pt-BR/configuration";
import {
  collectDocumentationTranslatableStrings,
  DocumentationSectionTranslationProvider,
  type DocumentationSectionTranslations,
} from "../section-localization";
import { ConfigurationBudgetAndCostControls } from "../sections/configuration-budget-and-cost-controls";

afterEach(cleanup);

function renderText() {
  const { container } = render(
    <MemoryRouter>
      <ConfigurationBudgetAndCostControls />
    </MemoryRouter>,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

function sourceNarrative() {
  const section = ConfigurationBudgetAndCostControls();
  const children = (section.props as { children?: ReactNode }).children;
  return collectDocumentationTranslatableStrings(children);
}

function renderLocalizedText(translations: DocumentationSectionTranslations) {
  const { container } = render(
    <MemoryRouter>
      <DocumentationSectionTranslationProvider translations={translations}>
        <ConfigurationBudgetAndCostControls />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

describe("budget and cost-control documentation against main", () => {
  it("documents the fixed API-key bucket and the stored field boundary", () => {
    const text = renderText();

    expect(text).toContain("fixed at 100 requests per minute");
    expect(text).toContain("does not read max_requests_per_minute");
    expect(text).toContain("first 20 characters");
    expect(text).not.toContain("can be tuned per-runner");
  });

  it("separates the two cost event payloads and generic webhook delivery", () => {
    const text = renderText();

    expect(text).toContain("cost_usd_7d");
    expect(text).toContain("cost_usd_30d");
    expect(text).toContain("threshold_usd_per_15min");
    expect(text).toContain("two different payload shapes");
    expect(text).toContain("generic signed HTTP POST");
    expect(text).not.toMatch(/Slack|PagerDuty|once per threshold per period/);
  });

  it("describes the real rolling budget window and panel", () => {
    const text = renderText();

    expect(text).toContain("trailing 30 days");
    expect(text).toContain("no agent-level cap");
    expect(text).not.toContain("per-workspace default (10 USD today)");
    expect(text).not.toContain("three pill badges");
  });

  it.each([
    ["es", ES_CONFIGURATION["budget-and-cost-controls"]],
    ["pt-BR", PT_BR_CONFIGURATION["budget-and-cost-controls"]],
  ] as const)("keeps the section complete in %s", (_locale, translations) => {
    const source = new Set(sourceNarrative());
    const translated = new Set(Object.keys(translations));

    expect({
      missing: [...source].filter((value) => !translated.has(value)),
      unexpected: [...translated].filter((value) => !source.has(value)),
    }).toEqual({ missing: [], unexpected: [] });
  });

  it("composes the corrected Spanish copy around stable technical tokens", () => {
    const text = renderLocalizedText(
      ES_CONFIGURATION["budget-and-cost-controls"],
    );

    expect(text).toContain("está fijo en 100 solicitudes por minuto");
    expect(text).toContain("no lee max_requests_per_minute");
    expect(text).toContain("dos formas de payload diferentes");
    expect(text).toContain("POST HTTP genérico y firmado");
  });

  it("composes the corrected PT-BR copy around stable technical tokens", () => {
    const text = renderLocalizedText(
      PT_BR_CONFIGURATION["budget-and-cost-controls"],
    );

    expect(text).toContain("é fixo em 100 requisições por minuto");
    expect(text).toContain("não lê max_requests_per_minute");
    expect(text).toContain("dois formatos diferentes de payload");
    expect(text).toContain("POST HTTP genérico e assinado");
  });
});
