// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { beforeEach, describe, expect, it } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { TimelineSimulator } from "../TimelineSimulator";
import { card, GENERATION_ID, HISTORY_BASE, generation, historyEvent, overview, readyWindow, sequence } from "../../__tests__/history-fixtures";

const API_URL = `/api${HISTORY_BASE}`;
let windowSelectors: URLSearchParams[];
let searched: string[];

beforeEach(() => {
  windowSelectors = [];
  searched = [];
  server.use(
    http.post(`${API_URL}/generations`, () => HttpResponse.json(generation(), { status: 201 })),
    http.get(`${API_URL}/generations/${GENERATION_ID}/overview`, () => HttpResponse.json(overview())),
    http.get(`${API_URL}/generations/${GENERATION_ID}/window`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      windowSelectors.push(params);
      const response = readyWindow(params.has("at_seq") ? 42 : 9998);
      response.events[0] = historyEvent(params.has("at_seq") ? 42 : 9998, {
        entity_type: "card", entity_id: "card-one", action: "dependency_added", summary: "Linked a dependency",
      });
      return HttpResponse.json(response);
    }),
    http.get(`${API_URL}/generations/${GENERATION_ID}/search`, ({ request }) => {
      searched.push(new URL(request.url).searchParams.get("q") ?? "");
      return HttpResponse.json({ generation_id: GENERATION_ID, scope: "generation", matches: [{ id: "earlier-decision", seq: sequence(42), created_at: "2025-02-01T00:00:00Z", summary: "Earlier decision" }], next_cursor: null });
    }),
    http.get(`${API_URL}/generations/${GENERATION_ID}/live-head`, () => HttpResponse.json({ generation_id: GENERATION_ID, observed_at: generation().created_at, head_seq: generation().head_seq, state: { columns: readyWindow().anchor.state.columns, cards: [card({ title: "Observed today", column_id: "done" })] } })),
    // A successful old endpoint makes the current implementation fail on behavior, not a network outage.
    http.get(API_URL, () => HttpResponse.json({ board_id: generation().board_id, generated_at: generation().created_at, truncated: true, events: [historyEvent(0)], baseline: { columns: readyWindow().anchor.state.columns, cards: [card({ title: "Observed today", column_id: "done" })] } })),
  );
});

describe("TimelineSimulator generation history", () => {
  it("shows the complete overview and recent anchored replay with explicit local filter scope", async () => {
    renderWithProviders(<TimelineSimulator slug="test-ws" boardId="development" />);
    const summary = await screen.findByRole("region", { name: /history overview|full history/i });
    expect(within(summary).getByText(/10[,. ]?001/)).toBeInTheDocument();
    const replay = screen.getByTestId("replay-board");
    expect(within(replay).getByText("Recorded draft")).toBeInTheDocument();
    expect(within(replay).queryByText("Observed today")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: /this window/i })).toBeInTheDocument();
    expect(screen.queryByText(/later activity was capped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/early events predate full history capture/i)).not.toBeInTheDocument();
    expect(windowSelectors[0]?.has("at_seq")).toBe(false);
    expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("max", "2");
  });

  it("seeks a whole-history search match outside the loaded window without filtering replay input", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TimelineSimulator slug="test-ws" boardId="development" />);
    const globalSearch = await screen.findByRole("searchbox", { name: /search (all|entire) history/i });
    await user.type(globalSearch, "decision{Enter}");
    await user.click(await screen.findByRole("button", { name: /Earlier decision/i }));
    await waitFor(() => expect(windowSelectors.at(-1)?.get("at_seq")).toBe(sequence(42)));
    expect(searched).toContain("decision");
    expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("max", "2");
    await user.type(screen.getByRole("searchbox", { name: /this window/i }), "no local match");
    expect(screen.getByRole("slider", { name: "Timeline position" })).toHaveAttribute("max", "2");
    expect(within(screen.getByTestId("replay-board")).getByText("Recorded draft")).toBeInTheDocument();
  });
});
