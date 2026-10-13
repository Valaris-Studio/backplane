// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { renderWithProviders, screen, stubReducedMotion, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { NoteList } from "../NoteList";

// Editor internals are irrelevant to resolving a retained source link. The
// actual NoteList, detail/list queries, API client and QueryClient remain real.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: () => <textarea aria-label="Note content editor" />,
}));

const PATH = "/receipt-workspace/boards/board-47/notes?note=note-historical-47&keep=1";
const API = "/api/workspaces/receipt-workspace/boards/board-47/notes";
function LocationProbe() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output>; }

function setup(status: number) {
  const state = { status, calls: 0, mutations: 0 };
  server.use(
    http.get("/api/workspaces/receipt-workspace/members", () => HttpResponse.json([])),
    http.get(API, () => HttpResponse.json([], { headers: { "X-Total-Count": "0" } })),
    http.get(`${API}/note-historical-47`, () => {
      state.calls += 1;
      return HttpResponse.json({ detail: "fixture request failed" }, { status: state.status });
    }),
    http.patch(`${API}/note-historical-47`, () => { state.mutations += 1; return HttpResponse.json({}); }),
  );
  renderWithProviders(<><NoteList slug="receipt-workspace" boardId="board-47" /><LocationProbe /></>, {
    routerProps: { initialEntries: [PATH] },
  });
  return state;
}

beforeEach(() => stubReducedMotion(true));
afterEach(() => { cleanup(); stubReducedMotion(false); });

describe("a retained source link whose current note cannot be read", () => {
  it.each([403, 404])("keeps the deep link and states unavailable/access lost after HTTP %i", async (status) => {
    const state = setup(status);
    await waitFor(() => expect(state.calls).toBe(1));
    expect(await screen.findByText(/This note is unavailable or you no longer have access/i)).toBeVisible();
    expect(screen.getByTestId("location").textContent).toBe(PATH);
    expect(screen.queryByRole("textbox", { name: "Note content editor" })).not.toBeInTheDocument();
    expect(screen.queryByText(/note (was |has been )?deleted/i)).not.toBeInTheDocument();
    expect(state.mutations).toBe(0);
  });

  it("offers retry for a transient failure without deleting the deep link or making an empty note editable", async () => {
    const state = setup(503);
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByTestId("location").textContent).toBe(PATH);
    expect(screen.queryByText(/This note is unavailable or you no longer have access/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note content editor" })).not.toBeInTheDocument();
    state.status = 404;
    fireEvent.click(retry);
    await screen.findByText(/This note is unavailable or you no longer have access/i);
    expect(state.calls).toBe(2);
    expect(screen.getByTestId("location").textContent).toBe(PATH);
    expect(state.mutations).toBe(0);
  });
});
