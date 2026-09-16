// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/config";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ptBr from "@/i18n/locales/pt-BR.json";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { ContextSourcePicker } from "../../components/pipeline-builder/ContextSourcePicker";
import { ToolPicker } from "../../components/pipeline-builder/ToolPicker";
import {
  CLAUDE_BUILTINS,
  VALARIS_MCP_TOOLS,
} from "../toolCatalog";
import { CONTEXT_SOURCE_CATALOG } from "../contextSourceCatalog";
import { PROMPT_DESCRIPTION_KEYS_BY_SLUG } from "../promptDescriptionCatalog";
import { LIFECYCLE_KIND_COPY_KEYS_BY_KIND } from "../lifecycleKindCatalog";

const locales = { en, es, "pt-BR": ptBr } as const;

function catalogValue(catalog: object, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, catalog);
}

const requiredCatalogKeys = [
  ...CLAUDE_BUILTINS.map((tool) => tool.summaryKey),
  ...VALARIS_MCP_TOOLS.map((tool) => tool.summaryKey),
  ...CONTEXT_SOURCE_CATALOG.flatMap((source) => [
    source.displayNameKey,
    source.descriptionKey,
  ]),
  ...Object.values(PROMPT_DESCRIPTION_KEYS_BY_SLUG),
  ...Object.values(LIFECYCLE_KIND_COPY_KEYS_BY_KIND).flatMap((copyKeys) => [
    copyKeys.summary,
    copyKeys.whenToUse,
    ...("gotcha" in copyKeys ? [copyKeys.gotcha] : []),
  ]),
];

describe("agent builder catalogs localization contract", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("pt-BR");
  });

  afterAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("stores stable summary keys while preserving raw tool identifiers", () => {
    expect(CLAUDE_BUILTINS[0]).toEqual(
      expect.objectContaining({
        id: "Read",
        label: "Read",
        summaryKey: "toolCatalog.claudeBuiltins.Read.summary",
      }),
    );
    expect(VALARIS_MCP_TOOLS[0]).toEqual(
      expect.objectContaining({
        id: "mcp__valaris__activate_catalog_skill",
        label: "activate_catalog_skill",
        summaryKey:
          "toolCatalog.valarisMcp.activate_catalog_skill.summary",
      }),
    );
    expect(
      [...CLAUDE_BUILTINS, ...VALARIS_MCP_TOOLS].some(
        (tool) => "summary" in tool,
      ),
    ).toBe(false);
  });

  it.each(Object.entries(locales))(
    "%s defines every visible catalog key",
    (_locale, catalog) => {
      for (const key of requiredCatalogKeys) {
        expect(catalogValue(catalog, key), `${_locale}: ${key}`).toEqual(
          expect.any(String),
        );
      }
    },
  );

  it("renders and searches the localized tool summary", async () => {
    const summaryKey = "toolCatalog.claudeBuiltins.Read.summary";
    const localizedSummary = i18n.t(summaryKey);
    expect(localizedSummary).not.toBe(summaryKey);

    const user = userEvent.setup();
    renderWithProviders(<ToolPicker value={[]} onChange={vi.fn()} />);

    expect(screen.getByText(localizedSummary)).toBeInTheDocument();
    await user.type(
      screen.getByPlaceholderText(i18n.t("pipelineBuilder.llm.toolPicker.searchPlaceholder")),
      localizedSummary,
    );

    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.queryByText("Write")).not.toBeInTheDocument();
  });

  it("stores stable context-source copy keys and renders the localized name", () => {
    expect(CONTEXT_SOURCE_CATALOG[0]).toEqual(
      expect.objectContaining({
        kind: "card_notes",
        displayNameKey: "contextSourceCatalog.card_notes.name",
        descriptionKey: "contextSourceCatalog.card_notes.description",
      }),
    );
    expect(
      CONTEXT_SOURCE_CATALOG.some(
        (source) => "displayName" in source || "description" in source,
      ),
    ).toBe(false);

    const nameKey = "contextSourceCatalog.card_notes.name";
    const localizedName = i18n.t(nameKey);
    expect(localizedName).not.toBe(nameKey);

    renderWithProviders(
      <ContextSourcePicker
        value={[{ kind: "card_notes" }]}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByLabelText(
        i18n.t("pipelineBuilder.llm.contextSources.kindLabel"),
      ),
    ).toHaveTextContent(localizedName);
  });
});
