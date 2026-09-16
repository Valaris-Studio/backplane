// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ES_REFERENCE } from "../content/sections/es/reference";
import { resolveDocumentationSection } from "../section-registry";
import { DocumentationSectionTranslationProvider } from "../section-localization";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

const ENGINE_PROMPT_IMPERATIVES = [
  "Make the changes directly in the working tree. Do not return code in your response.",
  "Emit a single JSON object with a decision field. Do not write code. Do not create notes.",
  "Emit structured markdown findings. The platform will attach them to the card as a review note.",
  "Use the available MCP tools to create or update cards. The platform records the summary only.",
] as const;

function renderSpanishSection(slug: string) {
  const resolved = resolveDocumentationSection("es", slug);
  if (!resolved) throw new Error(`Missing documentation section: es:${slug}`);
  const Component = resolved.Component;

  return render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider
        translations={resolved.translations}
      >
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  ).container.textContent ?? "";
}

describe("Spanish documentation copy quality", () => {
  afterEach(cleanup);

  it.each([
    ["install-with-docker-compose", ".env ."],
    ["creating-your-first-workspace", "/{slug}/members ."],
    ["your-first-pipeline-run", "En curso ."],
    ["your-first-pipeline-run", "Panel del observador ,"],
    ["webhooks-and-external-notifications", "create_webhook ;"],
    ["event-bus-and-websocket-model", "ActivityAction ."],
    ["adding-a-new-pipeline-stage-variant", "linted ."],
    ["quick-tour", "herramientarequest_approval"],
    ["prompt-authoring-guide", "campodecision"],
  ])("does not render malformed composition in %s", (slug, malformedCopy) => {
    expect(renderSpanishSection(slug)).not.toContain(malformedCopy);
  });

  it("renders current Spanish runner narrative around technical tokens", () => {
    const pipelineRun = renderSpanishSection("your-first-pipeline-run");
    expect(pipelineRun).toContain(
      "ambos usan ${VALARIS_API_KEY} en lugar de incorporar",
    );
    expect(pipelineRun).toContain("single-role mode o multi-role mode");

    cleanup();
    expect(renderSpanishSection("custom-roles")).toContain(
      "agregar un security-auditor, un designer o un secretario",
    );
  });

  it("uses the localized visible Awaiting Prompt label", () => {
    const copy = renderSpanishSection("debugging-a-stuck-card");
    expect(copy).toContain("A la espera de un prompt");
    expect(copy).not.toContain("Awaiting Prompt");
  });

  it("localizes the visible In Progress label in the quick tour narrative", () => {
    const copy = renderSpanishSection("quick-tour");
    expect(copy).toContain("En curso");
  });

  it("keeps engine-injected prompt imperatives byte-stable", () => {
    const copy = renderSpanishSection("prompt-authoring-guide");

    for (const imperative of ENGINE_PROMPT_IMPERATIVES) {
      expect(copy).toContain(imperative);
    }
  });

  it("localizes the empty MCP catalog branches outside the static collector", () => {
    expect(ES_REFERENCE["mcp-tool-catalog"]).toMatchObject({
      "Searchable, filterable, copy-ready. ":
        "Se puede buscar, filtrar y copiar. ",
    });
    expect(ES_REFERENCE["mcp-prompt-catalog"]).toMatchObject({
      "Prompts are organized by agent role. ":
        "Los prompts están organizados por rol de agente. ",
    });
  });
});
