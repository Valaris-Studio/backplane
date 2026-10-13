// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import i18n from "@/i18n/config";
import {
  createTestQueryClient, renderWithProviders, screen, waitFor, within,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { WebSocketEvent } from "@/lib/websocket";
import { ExecutionDetailPage } from "@/pages/ExecutionDetailPage";

// A dispatch receipt without a budget opt-in: schema-1 manifest (no admission,
// budget or diagnostics) whose dispatch.source_inclusions still name the
// required source. Inclusions are reversed relative to sources, so only a
// source_index join labels the right row. Body is a server-schema round-tripped
// fixture served at the HTTP edge; only the WebSocket transport is substituted.
const transport = vi.hoisted(() => ({
  status: "connected" as const,
  subscribe(_pattern: string, _handler: (event: WebSocketEvent) => void) {
    return () => {};
  },
}));
vi.mock("@/providers/WebSocketProvider", () => ({ useWebSocketContext: () => transport }));

type Json = Record<string, unknown>;
const body = JSON.parse(readFileSync(
  path.resolve(__dirname, "fixtures/budget-supplemental/receipt-schema1-dispatch-required.json"),
  "utf8",
)) as Json;

const SLUG = "budget-workspace";
const EXECUTION_ID = "8f0e8a54-5d4b-4c55-9d0e-0000000000e1";
const BASE = `/api/workspaces/${SLUG}/executions/${EXECUTION_ID}`;
const ALIASES = ["HandoffNotes", "BriefingNotes", "StageRules"];

function serve() {
  const summary: Json = { ...body };
  for (const key of ["context_manifest", "input_prompt", "system_prompt", "dispatch"]) delete summary[key];
  server.use(
    http.get(BASE, () => HttpResponse.json({
      id: EXECUTION_ID, agent_id: "agent-budget", workspace_id: "8f0e8a54-5d4b-4c55-9d0e-000000000001",
      board_id: "8f0e8a54-5d4b-4c55-9d0e-000000000002", session_id: null, action: "review",
      status: "completed", started_at: "2026-10-13T14:00:00Z", completed_at: "2026-10-13T14:05:00Z",
      input_summary: "Synthetic schema-1 dispatch receipt", output_summary: null, tools_used: [],
      cards_affected: [], cards_affected_detail: [], error_message: null, tool_calls_count: 0,
      tokens_used: 0, cost_usd: 0, duration_seconds: 300, parent_execution_id: null, role: "review",
      prompt_slug: "review", model: "execution-model", provider: "execution-provider",
      input_prompt: "legacy mutable prompt", tool_invocations: [],
      context_receipt_count: 1, context_binding: null,
    })),
    http.get(`/api/workspaces/${SLUG}/metrics/agents`, () => HttpResponse.json({ agents: [] })),
    http.get(`${BASE}/context-receipts`, () =>
      HttpResponse.json([summary], { headers: { "X-Total-Count": "1" } })),
    http.get(`${BASE}/context-receipts/:receiptId`, ({ params }) =>
      params.receiptId === body.id
        ? HttpResponse.json(body)
        : HttpResponse.json({ detail: "Context receipt not found" }, { status: 404 })),
  );
  const queryClient = createTestQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 60_000 } });
  renderWithProviders(
    <Routes><Route path="/:slug/agents/executions/:executionId" element={<ExecutionDetailPage />} /></Routes>,
    { queryClient, routerProps: { initialEntries: [`/${SLUG}/agents/executions/${EXECUTION_ID}`] } },
  );
}

const panel = () => screen.getByRole("tabpanel", { name: "Prompt" });
async function openPrompt() {
  serve();
  fireEvent.click(await screen.findByRole("tab", { name: /^Prompt$/ }));
  await waitFor(() =>
    expect(screen.getByTestId("execution-prompt-body").textContent).toBe(body.input_prompt));
}
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
  await i18n.changeLanguage("en");
});

describe("schema-1 manifest with a dispatch receipt", () => {
  it("marks the row required from the inclusion joined by source index", async () => {
    await openPrompt();
    expect(within(panel()).getByText("Required context was found verbatim in this prompt.")).toBeVisible();
    expect(row("HandoffNotes")).toHaveAccessibleName(/required/);
    expect(row("BriefingNotes")).not.toHaveAccessibleName(/required/);
    expect(row("StageRules")).not.toHaveAccessibleName(/required/);
  });

  it("marks the required row in the active locale", async () => {
    await i18n.changeLanguage("es");
    await openPrompt();
    expect(row("HandoffNotes")).toHaveAccessibleName(/obligatoria/);
    expect(row("StageRules")).not.toHaveAccessibleName(/obligatoria/);
  });

  it("shows each source's own inclusion beside its schema-1 coverage", async () => {
    await openPrompt();
    expect(row("HandoffNotes")).toHaveAccessibleName(/1 occurrence/);
    expect(row("HandoffNotes")).toHaveAccessibleName(/found verbatim in prompt/);
    expect(row("HandoffNotes")).not.toHaveAccessibleName(/not found verbatim/);
    expect(row("BriefingNotes")).toHaveAccessibleName(/found verbatim in prompt/);
    expect(row("StageRules")).toHaveAccessibleName(/source snapshot/);
    expect(row("StageRules")).toHaveAccessibleName(/not found verbatim/);
    expect(within(region("HandoffNotes")).getByText("Found verbatim 1 time in the prompt (36 bytes).")).toBeVisible();
    expect(within(region("StageRules")).getByText(
      "Its exact block is not in the prompt; it may have been reworded or omitted. Its contribution is unknown.",
    )).toBeVisible();
  });

  it("renders no admission, budget or exclusion copy", async () => {
    await openPrompt();
    for (const alias of ALIASES) region(alias);
    expect(panel().textContent).not.toMatch(
      /admitted|left out|candidates?\b|nothing matched|Showing \d+ of|more than \d+ notes?|Every candidate|Source block|Board definition/i,
    );
    expect(within(panel()).queryByRole("list", { name: /Left out/ })).not.toBeInTheDocument();
    expect(within(panel()).getByText(/agent execution and source use have not been verified/i)).toBeVisible();
    expect(within(panel()).getAllByRole("link")).toHaveLength(2);
  });
});
