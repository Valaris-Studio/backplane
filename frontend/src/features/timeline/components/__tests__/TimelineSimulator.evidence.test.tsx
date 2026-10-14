// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, it } from "vitest";
import { renderWithProviders, screen, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { TimelineSimulator } from "../TimelineSimulator";
import { card, generation, overview, readyWindow, historyEvent, HISTORY_BASE, GENERATION_ID } from "../../__tests__/history-fixtures";

it("uses selected-prefix column names in captions, matching the historical board", async () => {
  const window = readyWindow(42);
  window.events = [
    historyEvent(42, { entity_type: "card", entity_id: "card-one", action: "moved", summary: "", before_state: card(), after_state: card({ column_id: "done" }), changes: { column_id: { old: "backlog", new: "done" } } }),
    historyEvent(43, { entity_type: "column", entity_id: "done", action: "updated", after_state: { ...window.anchor.state.columns[1]!, name: "Future renamed column" } }),
  ];
  server.use(
    http.post(`/api${HISTORY_BASE}/generations`, () => HttpResponse.json(generation())),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/overview`, () => HttpResponse.json(overview())),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/window`, () => HttpResponse.json(window)),
  );
  renderWithProviders(<TimelineSimulator slug="test-ws" boardId="development" />);
  expect(await screen.findByTestId("replay-column-done")).toHaveTextContent("Done");
  expect(within(screen.getByTestId("timeline-controls")).queryByText(/Future renamed column/)).not.toBeInTheDocument();
});

it("keeps the full-history day origin when opening a later detail window", async () => {
  const window = readyWindow(42);
  window.events[0] = historyEvent(42, { created_at: "2026-09-30T00:00:00Z" });
  server.use(
    http.post(`/api${HISTORY_BASE}/generations`, () => HttpResponse.json(generation())),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/overview`, () => HttpResponse.json({ ...overview(), first_at: "2026-01-01T00:00:00Z" })),
    http.get(`/api${HISTORY_BASE}/generations/${GENERATION_ID}/window`, () => HttpResponse.json(window)),
  );
  renderWithProviders(<TimelineSimulator slug="test-ws" boardId="development" />);
  expect(await screen.findByTestId("step-day-chip")).toHaveTextContent("Day 273");
});
