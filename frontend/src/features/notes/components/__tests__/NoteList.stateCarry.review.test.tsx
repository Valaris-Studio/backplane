// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { ContextLink, ReturnLink } from "@/components/shared/ContextLink";
import { renderBrowserNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { stubAuthModes } from "@/features/sessions/__tests__/fixtures";
import type { Note } from "@/types/note";
import { NoteList } from "../NoteList";

const origin = "/acme/sessions/private-session?filter=private-investigation#content-private";
const destination = "/acme/notes?note=shared-note&sort=updated";
const note: Note = {
  id: "shared-note", workspace_id: "ws-1", board_id: null, card_id: null,
  title: "Shared destination", content: "<p>Saved shared note body.</p>", pinned: false,
  kind: "user_note", failure_class: null, findings: null, source_execution_id: null,
  created_by: "user-me", created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z",
};

function mount() {
  const traffic = { writes: [] as string[], unexpected: [] as string[] };
  stubAuthModes(false);
  server.use(http.all("/api/*", ({ request }) => {
    const path = new URL(request.url).pathname;
    const key = `${request.method} ${path}`;
    if (request.method !== "GET") traffic.writes.push(key);
    if (request.method === "GET") {
      if (path === "/api/auth/modes" || path === "/api/me") return;
      if (path === "/api/workspaces/acme/notes") {
        const summary = Object.fromEntries(Object.entries(note).filter(([key]) => key !== "content"));
        return HttpResponse.json([{ ...summary, preview: "Saved shared note body." }], { headers: { "X-Total-Count": "1" } });
      }
      if (path === "/api/workspaces/acme/notes/shared-note") return HttpResponse.json(note);
      if (path === "/api/workspaces/acme/members") return HttpResponse.json([]);
      if (path === "/api/workspaces/acme/boards") return HttpResponse.json([]);
      if (path === "/api/workspaces/acme/agents") return HttpResponse.json([]);
      if (path === "/api/workspaces/acme/config/completion-context-impact") return HttpResponse.json({ attempts: [] });
    }
    traffic.unexpected.push(key);
    return HttpResponse.json({ detail: "Unexpected state-carry fixture request" }, { status: 400 });
  }));
  const rendered = renderBrowserNavigationRouter([
    { path: "/acme/sessions/private-session", element: <ContextLink id="private-reading-origin" to={destination}>Open shared note</ContextLink> },
    { path: "/acme/notes", element: <><NoteList slug="acme" /><ReturnLink to="/acme/notes" returnLabel="Return to private reading">Notes</ReturnLink></> },
  ], origin);
  return { ...rendered, traffic };
}

beforeEach(() => { localStorage.clear(); stubReducedMotion(true); });
afterEach(() => stubReducedMotion(false));

describe("NoteList same-page replacement preserves an opaque return reference", () => {
  it("closes a clean note without dropping the return state or leaking its private origin into the URL", async () => {
    const { router, traffic } = mount();
    const originKey = router.state.location.key;
    await userEvent.click(screen.getByRole("link", { name: "Open shared note" }));
    await screen.findByDisplayValue(note.title);
    const state = router.state.location.state;
    expect(state).toEqual({ bpReturn: { v: 1, originKey, originIdx: 0 } });
    expect(JSON.stringify(state)).not.toMatch(/private-session|private-investigation|content-private/);
    expect(router.state.location.pathname + router.state.location.search).toBe(destination);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(router.state.location.search).toBe("?sort=updated"));
    expect(screen.queryByDisplayValue(note.title)).not.toBeInTheDocument();
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location.pathname + router.state.location.search).toBe("/acme/notes?sort=updated");
    expect(traffic.writes).toEqual([]);
    expect(traffic.unexpected).toEqual([]);
    expect(router.state.location.state).toEqual(state);

    await userEvent.click(screen.getByRole("link", { name: "Return to private reading" }));
    await waitFor(() => expect(router.state.location.key).toBe(originKey));
    expect(router.state.historyAction).toBe("POP");
    expect(router.state.location.pathname + router.state.location.search + router.state.location.hash).toBe(origin);
  });

  it("Cancel keeps the dirty note, URL and opaque state without a write or replacement", async () => {
    const { router, traffic } = mount();
    await userEvent.click(screen.getByRole("link", { name: "Open shared note" }));
    const title = await screen.findByDisplayValue(note.title);
    const before = router.state.location;
    fireEvent.change(title, { target: { value: "Unsaved local title" } });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByTestId("unsaved-changes-prompt")).toBeVisible());
    await userEvent.click(screen.getByTestId("unsaved-changes-keep-editing"));

    expect(screen.getByDisplayValue("Unsaved local title")).toBeVisible();
    expect(router.state.location).toEqual(before);
    expect(router.state.location.pathname + router.state.location.search).toBe(destination);
    expect(traffic.writes).toEqual([]);
    expect(traffic.unexpected).toEqual([]);
  });
});
