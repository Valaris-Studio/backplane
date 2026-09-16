// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import i18n from "@/i18n/config";
import { renderWithProviders } from "@/test/test-utils";
import { DocumentationPage } from "@/pages/DocumentationPage";
import {
  DocumentationLanding,
  DocumentationSection,
} from "@/pages/documentation";
import { McpToolReference } from "../mcp-reference";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

function renderDocumentation(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/documentation" element={<DocumentationPage />}>
        <Route index element={<DocumentationLanding />} />
        <Route path=":sectionSlug" element={<DocumentationSection />} />
      </Route>
    </Routes>,
    { routerProps: { initialEntries: [path] } },
  );
}

describe.each([
  {
    locale: "es",
    pageTitle: "Documentación",
    groupTitle: "Introducción",
    sectionTitle: "Qué es Backplane",
    tocLabel: "Secciones de documentación",
  },
  {
    locale: "pt-BR",
    pageTitle: "Documentação",
    groupTitle: "Introdução",
    sectionTitle: "O que é o Backplane",
    tocLabel: "Seções da documentação",
  },
] as const)("$locale documentation UI", (expected) => {
  it("localizes the shell, landing groups and stable section route", async () => {
    await i18n.changeLanguage(expected.locale);
    renderDocumentation("/workspace/documentation/what-backplane-is");

    expect(
      screen.getByRole("heading", { name: expected.pageTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: expected.tocLabel }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: expected.sectionTitle }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(expected.groupTitle).length).toBeGreaterThan(0);
  });
});

describe("localized MCP reference chrome", () => {
  it("uses bundled Brazilian Portuguese copy without an external service", async () => {
    await i18n.changeLanguage("pt-BR");
    renderWithProviders(
      <McpToolReference tools={[]} prompts={[]} resources={[]} />,
      {
        routerProps: {
          initialEntries: ["/documentation/mcp-tool-catalog"],
        },
      },
    );

    expect(
      screen.getByRole("navigation", { name: "Referência MCP" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("searchbox", { name: "Pesquisar na referência MCP" }),
    ).toHaveAttribute(
      "placeholder",
      'Pesquisar ferramentas…  ("/" para focar)',
    );
    expect(screen.getByText("Nenhum resultado.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Limpar pesquisa e filtros" }),
    ).toBeInTheDocument();
  });
});
