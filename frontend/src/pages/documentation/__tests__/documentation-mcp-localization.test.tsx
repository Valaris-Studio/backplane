// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { McpToolReference } from "../mcp-reference";
import type { ToolDoc } from "../mcp-reference/data";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import {
  collectDocumentationTechnicalContract,
  compareDocumentationTechnicalContracts,
} from "../technical-contract";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

const tool: ToolDoc = {
  name: "claim_card",
  category: "cards",
  kind: "composite",
  description: "Claim a card for the current agent.",
  params: [
    {
      name: "card_id",
      required: true,
      description: "UUID of the card to claim.",
    },
  ],
  gotchas: ["Use the active column."],
  danger: "This operation mutates shared state.",
  examplePrompt: "Use claim_card with card_id=<id>.",
};

function renderReference(translations: Readonly<Record<string, string>>) {
  return render(
    <MemoryRouter initialEntries={["/documentation/mcp-tool-catalog#tool-claim_card"]}>
      <DocumentationSectionTranslationProvider translations={translations}>
        <McpToolReference tools={[tool]} prompts={[]} resources={[]} />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );
}

describe("MCP documentation localization boundary", () => {
  it("translates owned narrative without changing MCP technical bytes", () => {
    const source = renderReference({});
    const sourceContract = collectDocumentationTechnicalContract(source.container);
    cleanup();

    const localized = renderReference({
      "Claim a card for the current agent.":
        "Reserve um cartão para o agente atual.",
      "UUID of the card to claim.": "UUID do cartão que será reservado.",
      "Use the active column.": "Use a coluna ativa.",
      "This operation mutates shared state.":
        "Esta operação altera o estado compartilhado.",
      claim_card: "reservar_cartao",
      card_id: "id_do_cartao",
      composite: "composto",
      "Use claim_card with card_id=<id>.":
        "Use reservar_cartao com id_do_cartao=<id>.",
    });

    expect(
      screen.getByText("Reserve um cartão para o agente atual."),
    ).toBeInTheDocument();
    expect(screen.getByText("UUID do cartão que será reservado.")).toBeInTheDocument();
    expect(screen.getByText("Use a coluna ativa.")).toBeInTheDocument();
    expect(
      screen.getByText("Esta operação altera o estado compartilhado."),
    ).toBeInTheDocument();

    expect(screen.getAllByText("claim_card").length).toBeGreaterThan(0);
    expect(screen.getByText("card_id")).toBeInTheDocument();
    expect(screen.getByText("composite")).toBeInTheDocument();
    expect(localized.container.querySelector("pre code")?.textContent).toBe(
      "Use claim_card with card_id=<id>.",
    );

    const localizedContract = collectDocumentationTechnicalContract(
      localized.container,
    );
    expect(
      compareDocumentationTechnicalContracts(sourceContract, localizedContract),
    ).toEqual([]);
  });
});
