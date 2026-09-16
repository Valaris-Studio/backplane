// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PT_BR_CONFIGURATION } from "../content/sections/pt-BR/configuration";
import { PT_BR_GETTING_STARTED } from "../content/sections/pt-BR/getting-started";
import { PT_BR_REFERENCE } from "../content/sections/pt-BR/reference";
import { McpToolReference } from "../mcp-reference";
import { TOOL_DOCS } from "../mcp-reference/data";
import { DocumentationSectionTranslationProvider } from "../section-localization";
import { resolveDocumentationSection } from "../section-registry";

vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => true,
}));

vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

const AGENT_EXECUTABLE_IMPERATIVE_ALLOWLIST = [
  "Make the changes directly in the working tree. Do not return code in your response.",
  "Emit a single JSON object with a decision field. Do not write code. Do not create notes.",
  "Emit structured markdown findings. The platform will attach them to the card as a review note.",
  "Use the available MCP tools to create or update cards. The platform records the summary only.",
] as const;

const NARRATIVE_GLOSSARY_SLUGS = [
  "mcp-tool-catalog",
  "mcp-prompt-catalog",
  "column-type-semantics",
  "card-type-and-priority",
  "api-authentication-modes",
] as const;

const MCP_GLOSSARY_TECHNICAL_ALLOWLIST: Readonly<
  Record<string, readonly string[]>
> = {
  'Set these nullable fields to null: due_date, status, labels, pr_url, branch_name, git_repo_slug. For example, clear_fields=["due_date"].': [
    "labels",
  ],
  'Omitted fields and explicit null values keep their current values. Use clear_fields to remove nullable values; setting and clearing the same field is rejected. Use description="" to clear a description, and labels=[] for an empty label list.': [
    "labels",
  ],
  '"system" (default) or "workspace" — which namespace template_ref lives in.': [
    "workspace",
  ],
  'Reference links, as [{"url", "label"?}].': ["label"],
  'Links and docs, as [{"url", "label"?}].': ["label"],
  "Filter: board, column, card, note, resource, definition, channel, git_repo, workspace, member, agent.":
    ["board", "card", "workspace"],
  "Only WORKSPACE-scoped prompt configs are included; platform defaults re-seed on the target and are deliberately excluded.":
    ["WORKSPACE"],
  "Keep the cards but slim each to id/column_id/title/status/priority/card_type/labels for large boards.":
    ["labels"],
  "labels REPLACES the whole list; to add one label, send the existing labels plus the new one.":
    ["labels"],
  "List of card objects. Each needs column_id and title; optional: description, card_type, priority, due_date, status, labels and git_repo_slug.": ["labels"],
  'Declarative run-complete condition, {"label": ..., "exclude_column_type": "done"} — the runner evaluates it before each iteration and disables the loop itself when zero cards match, without spawning a session. It also verifies any session\'s objective_complete claim. Pass {} to clear it (omitting the field leaves it unchanged).': [
    "label",
  ],
  "Return compact cards — id, title, column_id, column_name, column_type, labels, priority, status, card_type only. Recommended for browse and triage queries; full responses carry every description and participant list.": [
    "labels",
  ],
  "On multi-repo boards, slug is the per-card selector (card.git_repo_slug); pick it deliberately.": [
    "card.git_repo_slug",
  ],
  "cost.agents holds per-runner token and execution counts over 7d/30d; dollar amounts live on cost.cards (total_cost_usd) and depend on model_pricing in workspace config — without it costs read as 0.": [
    "cost.cards",
  ],
  "Events to subscribe to: approval.created, approval.updated, execution.started, execution.completed, agent.status_changed, config.changed, cost.threshold_crossed, plus the activity.* namespace (activity.card.moved, activity.note.updated, ...). Bare card.*/column.* names still work but are deprecated aliases of activity.card.*/activity.column.*.": [
    "activity.card.moved",
    "activity.card.*",
    "card.*",
  ],
};

function removeAllowlistedMcpTerms(source: string, localized: string) {
  return (MCP_GLOSSARY_TECHNICAL_ALLOWLIST[source] ?? []).reduce(
    (remaining, technicalTerm) =>
      remaining.replace(technicalTerm, " ".repeat(technicalTerm.length)),
    localized,
  );
}

function renderPtBrSection(slug: string, normalizeWhitespace = true) {
  const resolved = resolveDocumentationSection("pt-BR", slug);
  if (!resolved) throw new Error(`Missing PT-BR documentation section: ${slug}`);
  const Component = resolved.Component;
  const view = render(
    <MemoryRouter initialEntries={[`/documentation/${slug}`]}>
      <DocumentationSectionTranslationProvider
        translations={resolved.translations}
      >
        <Component />
      </DocumentationSectionTranslationProvider>
    </MemoryRouter>,
  );

  const text = view.container.textContent ?? "";
  return normalizeWhitespace ? text.replace(/\s+/g, " ") : text;
}

afterEach(cleanup);

describe("PT-BR documentation quality contract", () => {
  it("uses the product glossary in audited narrative reference sections", () => {
    const residuals = NARRATIVE_GLOSSARY_SLUGS.flatMap((slug) =>
      Object.entries(PT_BR_REFERENCE[slug]).flatMap(([source, localized]) =>
        /\b(?:boards?|cards?|workspaces?|labels?)\b/i.test(
          slug === "mcp-tool-catalog"
            ? removeAllowlistedMcpTerms(source, localized)
            : localized,
        )
          ? [`${slug}: ${source} -> ${localized}`]
          : [],
      ),
    );

    expect(residuals).toEqual([]);
  });

  it("keeps only the explicitly allowlisted MCP glossary terms technical", () => {
    const translations: Readonly<Record<string, string>> =
      PT_BR_REFERENCE["mcp-tool-catalog"];
    const staleExceptions = Object.entries(
      MCP_GLOSSARY_TECHNICAL_ALLOWLIST,
    ).flatMap(([source, technicalTerms]) => {
      let remaining = translations[source] ?? "";
      return technicalTerms.flatMap((technicalTerm) => {
        const index = remaining.indexOf(technicalTerm);
        if (index === -1) return [`${source} -> ${technicalTerm}`];
        remaining =
          remaining.slice(0, index) +
          " ".repeat(technicalTerm.length) +
          remaining.slice(index + technicalTerm.length);
        return [];
      });
    });

    expect(staleExceptions).toEqual([]);
  });

  it("translates the current visible card fields while preserving enum values", () => {
    const translations = PT_BR_GETTING_STARTED["your-first-board-and-card"];
    const cardFields =
      translations[
        "Use Add card at the bottom of a column. Title is the only required field. The dialog also exposes an optional description, card type, priority, target column, due date, status, labels, and participants. Creation defaults to type task and priority medium."
      ];

    expect(cardFields).toContain("prioridade");
    expect(cardFields).toContain("participantes");
    expect(cardFields).toContain("rótulos");
    expect(cardFields).toContain("tipo task");
    expect(cardFields).toContain("prioridade medium");
  });

  it("translates prompt scope prose without changing the technical tuple", () => {
    const translations = PT_BR_CONFIGURATION["prompt-authoring-guide"];

    expect(
      translations[
        '. Workspace and role scope the "who"; stage scopes the "when" (which ticking phase); team scopes to an agent team when you want a subset of runners to use a variant. The '
      ],
    ).toBe(
      '. O espaço de trabalho e a função delimitam "quem"; a etapa delimita "quando", ou seja, qual fase do ciclo; a equipe restringe a variante a um grupo de agentes quando apenas um subconjunto de runners deve usá-la. O ',
    );
  });

  it("uses grammatical PT-BR articles for LLM and API key copy", () => {
    const promptTranslations = PT_BR_REFERENCE["mcp-prompt-catalog"];
    expect(
      promptTranslations[
        "Prompts are server-authored multi-phase workflow templates. An MCP host (Claude Code, Claude Desktop, a runner) expands a prompt by name and gets back a long instruction block that the LLM then executes as a sequenced plan. The templates do not share one universal phase cadence or confirmation rule: "
      ],
    ).toContain("que o LLM executa");
    expect(
      promptTranslations[
        "Prompts are server-authored multi-phase workflow templates. An MCP host (Claude Code, Claude Desktop, a runner) expands a prompt by name and gets back a long instruction block that the LLM then executes as a sequenced plan. The templates do not share one universal phase cadence or confirmation rule: "
      ],
    ).toContain("não compartilham uma cadência universal");
    expect(
      promptTranslations[
        "Parameters are interpolated into the prompt body at expansion time. The LLM sees the rendered string; parameter names are not visible to it. Invoking a prompt is not a transaction boundary: the host sends rendered prose to the model, and any resulting tool calls still run through normal authentication, authorization, and MCP allowlist checks."
      ],
    ).toContain("O LLM vê a string renderizada");

    expect(
      PT_BR_REFERENCE["api-authentication-modes"][
        "Two provisioning knobs apply to verified browser identities (IAP, trusted proxy, and OIDC), not to API keys or dev mode:"
      ],
    ).toContain("mas não às API keys nem ao dev mode");
  });

  it("preserves the split invite-only responses in PT-BR", () => {
    const translations = PT_BR_REFERENCE["api-authentication-modes"];

    expect(
      translations[
        " switches to invite-only. IAP and trusted-proxy requests receive HTTP 403 when the verified email has no existing account. The OIDC callback redirects with HTTP 302 to"
      ],
    ).toContain("IAP e trusted proxy recebem HTTP 403");
    expect(
      translations[
        " instead; it does not return a 403 page from the callback. Neither path creates a fresh user row. The domain allowlist also gates the local-auth paths that mint a login-capable account: first-run setup and an admin invite that grants an initial password (a plain, passwordless membership invite is a deliberate act and is not domain-checked). Rejections are logged with reason codes such as "
      ],
    ).toContain("convite de membro sem senha");
    expect(
      translations[
        " instead; it does not return a 403 page from the callback. Neither path creates a fresh user row. The domain allowlist also gates the local-auth paths that mint a login-capable account: first-run setup and an admin invite that grants an initial password (a plain, passwordless membership invite is a deliberate act and is not domain-checked). Rejections are logged with reason codes such as "
      ],
    ).toContain("códigos de motivo");
  });

  it("covers both empty-catalog conditional branches", () => {
    expect(
      PT_BR_REFERENCE["mcp-tool-catalog"][
        "Searchable, filterable, copy-ready. "
      ],
    ).toBe("Pesquisável, filtrável e pronto para copiar. ");
    expect(
      PT_BR_REFERENCE["mcp-prompt-catalog"][
        "Prompts are organized by agent role. "
      ],
    ).toBe("Os prompts são organizados por função de agente. ");
  });

  it("localizes the done-column merge gate narrative without translating its enum", () => {
    const toolCatalogTranslations: Readonly<Record<string, string>> =
      PT_BR_REFERENCE["mcp-tool-catalog"];

    expect(
      toolCatalogTranslations[
        "Per-board done merge gate: 'inherit' clears the override and uses the workspace enforce_done_merge_gate setting; 'enforced' enables it; 'off' disables it. The gate applies to runner moves into done, not human moves."
      ],
    ).toBe(
      "Controle de merge para done por quadro: 'inherit' remove o override e usa enforce_done_merge_gate do espaço de trabalho; 'enforced' o ativa e 'off' o desativa. Aplica-se a movimentos de runners para done, não a movimentos humanos.",
    );
  });

  it("renders the localized done-column merge gate copy in the real update_board explorer", () => {
    const updateBoard = TOOL_DOCS.find(({ name }) => name === "update_board");
    if (!updateBoard) throw new Error("Missing update_board documentation");

    render(
      <MemoryRouter
        initialEntries={["/documentation/mcp-tool-catalog#tool-update_board"]}
      >
        <DocumentationSectionTranslationProvider
          translations={PT_BR_REFERENCE["mcp-tool-catalog"]}
        >
          <McpToolReference
            tools={[updateBoard]}
            prompts={[]}
            resources={[]}
          />
        </DocumentationSectionTranslationProvider>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        "Controle de merge para done por quadro: 'inherit' remove o override e usa enforce_done_merge_gate do espaço de trabalho; 'enforced' o ativa e 'off' o desativa. Aplica-se a movimentos de runners para done, não a movimentos humanos.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps allowlisted agent-executable imperatives byte-stable in English", () => {
    const text = renderPtBrSection("prompt-authoring-guide", false);

    for (const imperative of AGENT_EXECUTABLE_IMPERATIVE_ALLOWLIST) {
      expect(text).toContain(imperative);
    }
  });

  it.each([
    ["quick-tour", "chamada da ferramenta request_approval."],
    [
      "your-first-pipeline-run",
      "ambos usam ${VALARIS_API_KEY} em vez de incorporar",
    ],
    [
      "webhooks-and-external-notifications",
      "create_webhook, list_webhooks",
    ],
    [
      "event-bus-and-websocket-model",
      /ActivityEntityType (?:e|and) ActivityAction/,
    ],
    [
      "adding-a-new-mcp-tool",
      "decorator @mcp.tool() para registrar a ferramenta. Adicione",
    ],
    [
      "integrating-a-new-git-host",
      "interface forge.Provider independente do provedor agora controla a criação",
    ],
    ["debugging-a-stuck-card", "column_type=blocked; a descoberta"],
    [
      "event-taxonomy",
      "Atualmente esses nomes não podem ser selecionados pela API",
    ],
  ] satisfies ReadonlyArray<readonly [string, string | RegExp]>)(
    "composes %s without broken inline boundaries",
    (slug, expected) => {
      const text = renderPtBrSection(slug);
      if (typeof expected === "string") {
        expect(text).toContain(expected);
      } else {
        expect(text).toMatch(expected);
      }
    },
  );
});
