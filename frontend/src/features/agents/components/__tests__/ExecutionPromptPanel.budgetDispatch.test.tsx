// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import i18n from "@/i18n/config";
import {
  createTestQueryClient, renderWithProviders, screen, waitFor, within,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { WebSocketEvent } from "@/lib/websocket";
import { ExecutionDetailPage } from "@/pages/ExecutionDetailPage";

// Schema-2 budget/admission/diagnostics and dispatch inclusion in the existing
// Prompt panel. Bodies are server-schema round-tripped fixtures (see
// fixtures/budget and the evidence generator) served at the HTTP edge, so the
// real page, API client, hooks and React Query run unmodified. Only the
// WebSocket transport is substituted; live/auth behavior is covered elsewhere.
const transport = vi.hoisted(() => ({
  status: "connected" as const,
  subscribe(_pattern: string, _handler: (event: WebSocketEvent) => void) {
    return () => {};
  },
}));
vi.mock("@/providers/WebSocketProvider", () => ({ useWebSocketContext: () => transport }));

type Json = Record<string, unknown>;
const FIXTURES = path.resolve(__dirname, "fixtures/budget");
const fixture = (name: string): Json =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Json;

const SLUG = "budget-workspace";
const EXECUTION_ID = "8f0e8a54-5d4b-4c55-9d0e-0000000000e1";
const BASE = `/api/workspaces/${SLUG}/executions/${EXECUTION_ID}`;

function summaryOf(body: Json): Json {
  const row: Json = { ...body };
  for (const key of ["context_manifest", "input_prompt", "system_prompt", "dispatch"]) delete row[key];
  return row;
}

function serve(body: Json) {
  const requests: string[] = [];
  server.use(
    http.get(BASE, () => HttpResponse.json({
      id: EXECUTION_ID, agent_id: "agent-budget", workspace_id: "8f0e8a54-5d4b-4c55-9d0e-000000000001",
      board_id: "8f0e8a54-5d4b-4c55-9d0e-000000000002", session_id: null, action: "review",
      status: "completed", started_at: "2026-10-13T11:00:00Z", completed_at: "2026-10-13T11:05:00Z",
      input_summary: "Synthetic budget receipt", output_summary: null, tools_used: [],
      cards_affected: [], cards_affected_detail: [], error_message: null, tool_calls_count: 0,
      tokens_used: 0, cost_usd: 0, duration_seconds: 300, parent_execution_id: null, role: "review",
      prompt_slug: "review", model: "execution-model", provider: "execution-provider",
      input_prompt: "legacy mutable prompt", tool_invocations: [],
      context_receipt_count: 1, context_binding: null,
    })),
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () => HttpResponse.json({ agents: [] })),
    http.get(`${BASE}/context-receipts`, () =>
      HttpResponse.json([summaryOf(body)], { headers: { "X-Total-Count": "1" } })),
    http.get(`${BASE}/context-receipts/:receiptId`, ({ params }) =>
      params.receiptId === body.id
        ? HttpResponse.json(body)
        : HttpResponse.json({ detail: "Context receipt not found" }, { status: 404 })),
  );
  server.events.on("request:start", ({ request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 60_000 } });
  renderWithProviders(
    <Routes><Route path="/:slug/agents/executions/:executionId" element={<ExecutionDetailPage />} /></Routes>,
    { queryClient, routerProps: { initialEntries: [`/${SLUG}/agents/executions/${EXECUTION_ID}`] } },
  );
  return { requests };
}

const panel = () => screen.getByRole("tabpanel", { name: "Prompt" });
async function openPrompt(body: Json) {
  fireEvent.click(await screen.findByRole("tab", { name: /^Prompt$/ }));
  await waitFor(() =>
    expect(screen.getByTestId("execution-prompt-body").textContent).toBe(body.input_prompt));
}
// Row names concatenate the incumbent spans without separators, so match by
// substring; every alias in these fixtures is unique and not a prefix of another.
const row = (alias: string) => within(panel()).getByRole("button", { name: new RegExp(alias) });
function region(alias: string) {
  const button = row(alias);
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  const controlled = document.getElementById(button.getAttribute("aria-controls") ?? "");
  if (!controlled) throw new Error(`no disclosure region for ${alias}`);
  return controlled;
}

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(async () => {
  cleanup();
  server.events.removeAllListeners();
  await i18n.changeLanguage("en");
});

describe("dispatch receipt truth", () => {
  it("serves the summary row exactly as the server-schema summary fixture", () => {
    expect(summaryOf(fixture("receipt-schema2-dispatch.json")))
      .toEqual(fixture("summary-schema2-dispatch.json"));
  });

  it("adds the exact-inclusion line under the unchanged prepared / not-verified truth", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body); await openPrompt(body);
    expect(within(panel()).getByText("Prepared", { exact: true })).toBeVisible();
    expect(within(panel()).getByText(/agent execution and source use have not been verified/i)).toBeVisible();
    expect(within(panel()).getByText("Required context was found verbatim in this prompt.")).toBeVisible();
    expect(panel().textContent).not.toMatch(/dispatched|\bsent\b|consumed|used by|delivered/i);
  });

  it("states that no source was required when the dispatch required none", async () => {
    const body = fixture("receipt-schema2-nonnote-exclusions.json");
    serve(body); await openPrompt(body);
    expect(within(panel()).getByText("No context source was required for this invocation.")).toBeVisible();
    expect(within(panel()).queryByText(/Required context was found/)).not.toBeInTheDocument();
  });
});

describe("admission truth on source rows and disclosures", () => {
  it("says a budget-excluded source left candidates out instead of selecting nothing", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body); await openPrompt(body);
    expect(row("PinnedGuides")).toHaveAccessibleName(/0 of 2 admitted/);
    const pinned = region("PinnedGuides");
    expect(within(pinned).getByText("Every candidate was left out by context limits.")).toBeVisible();
    expect(pinned.textContent).not.toMatch(/No records were selected|Nothing matched/);
  });

  it("distinguishes a source where nothing matched from one whose candidates were excluded", async () => {
    const body = fixture("receipt-schema2-full-window.json");
    serve(body); await openPrompt(body);
    expect(row("NoMatches")).toHaveAccessibleName(/nothing matched/);
    const empty = region("NoMatches");
    expect(within(empty).getByText("Nothing matched this source.")).toBeVisible();
    expect(empty.textContent).not.toMatch(/left out|No records were selected/i);
  });

  it("shows partial true counts, the window fact and the source's own exclusions in server order", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body); await openPrompt(body);
    expect(row("ReviewerNotes")).toHaveAccessibleName(/1 of 3 admitted/);
    expect(row("ReviewerNotes")).toHaveAccessibleName(/more than 3 notes matched/);
    expect(row("HandoffNotes")).toHaveAccessibleName(/required/);
    expect(row("ReviewerNotes")).not.toHaveAccessibleName(/required/);
    const reviewer = region("ReviewerNotes");
    expect(within(reviewer).getByText(
      "More notes matched than this source reads (first 3). The rest were not considered or counted.",
    )).toBeVisible();
    const leftOut = within(reviewer).getByRole("list", { name: "Left out (2)" });
    const entries = within(leftOut).getAllByRole("listitem");
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Long reviewer transcript"),
      expect.stringContaining("Older reviewer note"),
    ]);
    expect(entries[0]).toHaveTextContent("Too large for an optional source");
    expect(entries[1]).toHaveTextContent("Note read budget already used");
    expect(entries[1]).toHaveTextContent(/\b900\b/);
    // Rendered size is null for this entry: nothing is shown, never a 0.
    expect(entries[1]!.textContent).not.toMatch(/\b0\b/);
    // diagnostics.truncated is global; this source lists all 2 of its 2 exclusions.
    expect(reviewer.textContent).not.toMatch(/Showing \d+ of \d+/);
    expect(reviewer.textContent).not.toMatch(/raise|increase/i);
  });

  it("reports a full 50-note window and singular counts without advising a larger window", async () => {
    const body = fixture("receipt-schema2-full-window.json");
    serve(body); await openPrompt(body);
    expect(row("WindowNotes")).toHaveAccessibleName(/more than 50 notes matched/);
    expect(row("RecentReviews")).toHaveAccessibleName(/4 of 5 admitted/);
    expect(within(panel()).getByText("1 candidate left out by context limits.")).toBeVisible();
    const window = region("WindowNotes");
    expect(within(window).getByText(
      "More notes matched than this source reads (first 50). The rest were not considered or counted.",
    )).toBeVisible();
    expect(panel().textContent).not.toMatch(/raise|increase|higher limit|more than 50 notes are read/i);
    const reviews = region("RecentReviews");
    expect(within(reviews).getByRole("list", { name: "Left out (1)" })).toBeVisible();
  });

  it("uses the receipt's global excluded count and per-source truncation only where entries are missing", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body); await openPrompt(body);
    expect(within(panel()).getByText("4 candidates left out by context limits.")).toBeVisible();
    const pinned = region("PinnedGuides");
    const leftOut = within(pinned).getByRole("list", { name: "Left out (2)" });
    expect(within(leftOut).getAllByRole("listitem")).toHaveLength(1);
    expect(within(pinned).getByText("Showing 1 of 2. The receipt keeps a bounded list.")).toBeVisible();
    expect(within(leftOut).getByRole("listitem")).toHaveTextContent("Larger than the per-note read limit");
  });
});

describe("exclusion labels and links", () => {
  it("labels the board definition only for a board_definition source and a generic block otherwise", async () => {
    const body = fixture("receipt-schema2-nonnote-exclusions.json");
    serve(body); await openPrompt(body);
    const guide = region("BoardGuide");
    const guideEntries = within(within(guide).getByRole("list", { name: "Left out (2)" })).getAllByRole("listitem");
    expect(guideEntries[0]).toHaveTextContent("Board definition");
    expect(guideEntries[0]).toHaveTextContent("Source size limit reached");
    expect(guideEntries[1]).toHaveTextContent("Release checklist");
    expect(guideEntries[1]).not.toHaveTextContent("Board definition");
    const stage = region("StageExpectations");
    const stageEntry = within(within(stage).getByRole("list", { name: "Left out (1)" })).getByRole("listitem");
    expect(stageEntry).toHaveTextContent("Source block");
    expect(stageEntry).toHaveTextContent("Shared context limit reached");
    expect(stageEntry).not.toHaveTextContent("Board definition");
  });

  it("renders excluded titles as plain text, keeps admitted note links and fetches nothing more", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    const { requests } = serve(body); await openPrompt(body);
    const before = [...requests];
    for (const alias of ["HandoffNotes", "ReviewerNotes", "PinnedGuides", "StagePolicy"]) region(alias);
    for (const title of ["Long reviewer transcript", "Older reviewer note", "Pinned architecture guide"]) {
      const text = within(panel()).getByText(title, { exact: false });
      expect(text.closest("a")).toBeNull();
    }
    const admitted = within(panel()).getByRole("link", { name: /Retained handoff — café 🧭/ });
    expect(admitted).toHaveAttribute("href",
      `/${SLUG}/boards/8f0e8a54-5d4b-4c55-9d0e-000000000002/notes?note=8f0e8a54-5d4b-4c55-9d0e-000000000101`);
    expect(within(panel()).getAllByRole("link").map((link) => link.textContent)).toEqual([
      expect.stringContaining("Retained handoff"), expect.stringContaining("Second handoff"),
      expect.stringContaining("Kept reviewer note"),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toEqual(before);
  });
});

describe("dispatch inclusion per source", () => {
  it("never renders an unknown contribution as zero, while a true empty block says nothing could enter", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body); await openPrompt(body);
    expect(row("StagePolicy")).toHaveAccessibleName(/not found verbatim/);
    const stage = region("StagePolicy");
    const unknown = within(stage).getByText(
      "Its exact block is not in the prompt; it may have been reworded or omitted. Its contribution is unknown.",
    );
    expect(unknown.textContent).not.toMatch(/\b0\b|bytes/);
    expect(row("PinnedGuides")).toHaveAccessibleName(/rendered nothing/);
    expect(within(region("PinnedGuides")).getByText(
      "This source rendered nothing, so nothing could enter the prompt.",
    )).toBeVisible();
    expect(row("HandoffNotes")).toHaveAccessibleName(/found verbatim in prompt/);
    expect(within(region("HandoffNotes")).getByText("Found verbatim 1 time in the prompt (66 bytes).")).toBeVisible();
  });

  it("joins source inclusions by source index, not by array position", async () => {
    const body = fixture("receipt-schema2-dispatch-reordered.json");
    serve(body); await openPrompt(body);
    expect(row("HandoffNotes")).toHaveAccessibleName(/found verbatim in prompt/);
    expect(row("ReviewerNotes")).toHaveAccessibleName(/found verbatim in prompt/);
    expect(row("PinnedGuides")).toHaveAccessibleName(/rendered nothing/);
    expect(row("StagePolicy")).toHaveAccessibleName(/not found verbatim/);
    expect(row("HandoffNotes")).not.toHaveAccessibleName(/not found verbatim|rendered nothing/);
  });

  it("keeps admission facts but claims no inclusion when the receipt has no dispatch", async () => {
    const body = fixture("receipt-schema2-no-dispatch.json");
    serve(body); await openPrompt(body);
    expect(row("PinnedGuides")).toHaveAccessibleName(/0 of 2 admitted/);
    expect(within(region("PinnedGuides")).getByRole("list", { name: "Left out (2)" })).toBeVisible();
    for (const alias of ["HandoffNotes", "ReviewerNotes", "PinnedGuides", "StagePolicy"]) region(alias);
    expect(panel().textContent).not.toMatch(/verbatim|rendered nothing|contribution|Required context was found|No context source was required/i);
    expect(within(panel()).getByText(/agent execution and source use have not been verified/i)).toBeVisible();
  });
});

describe("compatibility", () => {
  it("leaves a schema-1 receipt's rendering free of any budget or inclusion copy", async () => {
    const body = fixture("receipt-schema1-legacy.json");
    serve(body); await openPrompt(body);
    expect(row("HandoffNotes")).toHaveAccessibleName(/2 occurrences/);
    region("HandoffNotes");
    expect(panel().textContent).not.toMatch(/admitted|left out|verbatim|candidates?\b|nothing matched|Showing \d+ of/i);
    expect(within(panel()).getAllByRole("link")).toHaveLength(2);
  });

  it("shows unknown future enum values verbatim as inert text", async () => {
    const body = fixture("receipt-forward-compat-unknown-enums.json");
    serve(body); await openPrompt(body);
    expect(within(panel()).getByText(/future_verification_mode/)).toBeVisible();
    expect(row("StagePolicy")).toHaveAccessibleName(/future_inclusion_outcome/);
    expect(row("PinnedGuides")).toHaveAccessibleName(/future_admission_outcome/);
    const pinned = region("PinnedGuides");
    expect(pinned.textContent).toContain("future_reason_<img src=x onerror=alert(1)>");
    expect(panel().querySelector("img")).toBeNull();
    expect(panel().textContent).not.toMatch(/Required context was found verbatim/);
  });
});

describe("keyboard semantics", () => {
  it("keeps each source row a single disclosure button whose region holds the left-out list", async () => {
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body); await openPrompt(body);
    const user = userEvent.setup();
    const reviewer = row("ReviewerNotes");
    reviewer.focus();
    await user.keyboard("{Enter}");
    expect(reviewer).toHaveAttribute("aria-expanded", "true");
    const controlled = document.getElementById(reviewer.getAttribute("aria-controls") ?? "")!;
    const leftOut = within(controlled).getByRole("list", { name: "Left out (2)" });
    expect(within(leftOut).queryAllByRole("link")).toEqual([]);
    expect(within(leftOut).queryAllByRole("button")).toEqual([]);
    expect(leftOut.querySelectorAll("[tabindex]")).toHaveLength(0);
    await user.keyboard(" ");
    expect(reviewer).toHaveAttribute("aria-expanded", "false");
  });
});

describe("locales", () => {
  it.each([
    ["es", {
      truth: "El contexto obligatorio se encontró literalmente en este prompt.",
      summary: "4 candidatos quedaron fuera por los límites de contexto.",
      admitted: /0 de 2 admitidos/, required: /obligatoria/, more: /más de 3 notas coincidieron/,
      exact: /encontrada literalmente en el prompt/i, unknown: /no encontrada literalmente/i,
      excluded: "Todos los candidatos quedaron fuera por los límites de contexto.",
      leftOut: "Excluidos (2)", fetch: /El presupuesto de lectura de notas ya se agotó/,
      showing: "Se muestran 1 de 2. El recibo conserva una lista acotada.",
    }],
    ["pt-BR", {
      truth: "O contexto obrigatório foi encontrado literalmente neste prompt.",
      summary: "4 candidatos ficaram de fora pelos limites de contexto.",
      admitted: /0 de 2 admitidos/, required: /obrigatória/, more: /mais de 3 notas corresponderam/,
      exact: /encontrada literalmente no prompt/i, unknown: /não encontrada literalmente/i,
      excluded: "Todos os candidatos ficaram de fora pelos limites de contexto.",
      leftOut: "Excluídos (2)", fetch: /O orçamento de leitura de notas já se esgotou/,
      showing: "Mostrando 1 de 2. O recibo guarda uma lista limitada.",
    }],
  ])("renders the budget and inclusion copy in %s", async (locale, copy) => {
    await i18n.changeLanguage(locale);
    const body = fixture("receipt-schema2-dispatch.json");
    serve(body);
    fireEvent.click(await screen.findByRole("tab", { name: /^Prompt$/ }));
    await waitFor(() =>
      expect(screen.getByTestId("execution-prompt-body").textContent).toBe(body.input_prompt));
    expect(within(panel()).getByText(copy.truth)).toBeVisible();
    expect(within(panel()).getByText(copy.summary)).toBeVisible();
    expect(row("PinnedGuides")).toHaveAccessibleName(copy.admitted);
    expect(row("HandoffNotes")).toHaveAccessibleName(copy.required);
    expect(row("ReviewerNotes")).toHaveAccessibleName(copy.more);
    expect(row("HandoffNotes")).toHaveAccessibleName(copy.exact);
    expect(row("StagePolicy")).toHaveAccessibleName(copy.unknown);
    const pinned = region("PinnedGuides");
    expect(within(pinned).getByText(copy.excluded)).toBeVisible();
    expect(within(pinned).getByRole("list", { name: copy.leftOut })).toBeVisible();
    expect(within(pinned).getByText(copy.showing)).toBeVisible();
    expect(within(region("ReviewerNotes")).getByText(copy.fetch)).toBeVisible();
  });
});
