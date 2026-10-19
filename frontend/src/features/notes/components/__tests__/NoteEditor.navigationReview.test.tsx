// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Note } from "@/types/note";

vi.mock("../NoteEditorMeta", () => ({ NoteEditorMeta: () => null }));
vi.mock("../CreateNoteDialog", () => ({ CreateNoteDialog: () => null }));
vi.mock("@/features/members/api/use-members", () => ({ useMembers: () => ({ data: [] }) }));
vi.mock("@/features/kanban/components/CompletionContextWarning", () => ({ CompletionContextWarning: () => null }));
vi.mock("@/features/sessions/components/LinkedSessionsSection", () => ({ NoteSessionsSection: () => null }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Note body" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));
import { NoteList } from "../NoteList";

const note: Note = {
  id: "note-1", workspace_id: "workspace-1", board_id: "board-1", card_id: null,
  title: "Saved title", content: "<p>Saved body</p>", pinned: false, kind: "user_note",
  failure_class: null, findings: null, source_execution_id: null, created_by: "owner-1",
  created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z",
};
const listPath = "/acme/boards/board-1/notes?sort=updated";
const origin = `${listPath}&note=note-1`;
const apiPath = "/api/workspaces/acme/boards/board-1/notes";

function mount(status = 200) {
  const state = { saved: { ...note }, writes: [] as Record<string, unknown>[] };
  server.use(
    http.get(apiPath, () => HttpResponse.json([], { headers: { "X-Total-Count": "0" } })),
    http.get(`${apiPath}/note-1`, () => HttpResponse.json(state.saved)),
    http.put(`${apiPath}/note-1`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push(payload);
      if (status !== 200) return HttpResponse.json({ detail: "Save failed" }, { status });
      state.saved = { ...state.saved, ...payload, updated_at: "2026-10-18T04:01:00Z" };
      return HttpResponse.json(state.saved);
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/acme/boards/board-1/notes", element: <NoteList slug="acme" boardId="board-1" /> },
    { path: "/acme/sessions/session-1", element: <h1>Related session</h1> },
  ], { initialEntries: [origin] });
  return { ...rendered, state };
}

async function edit() {
  fireEvent.change(await screen.findByDisplayValue("Saved title"), { target: { value: "Reviewed title" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "<p>Reviewed body</p>" } });
}
beforeEach(() => { stubReducedMotion(true); });
afterEach(() => { stubReducedMotion(false); });

describe("NoteEditor approved modal close through the real note query", () => {
  it.each(["sheet Save", "modal Save"])("%s closes the saved deep link without reopening a route guard", async (action) => {
    const { router, client, state } = mount();
    const user = userEvent.setup();
    try {
      await edit();
      if (action === "modal Save") {
        await user.keyboard("{Escape}");
        await user.click(screen.getByTestId("unsaved-changes-save"));
      } else {
        await user.click(screen.getByRole("button", { name: "Save" }));
      }
      await waitFor(() => expect(state.writes).toEqual([{ title: "Reviewed title", content: "<p>Reviewed body</p>" }]));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(router.state.location.pathname + router.state.location.search).toBe(listPath);
      expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note body" })).not.toBeInTheDocument());
      await act(async () => { await router.navigate("/acme/sessions/session-1"); });
      expect(screen.getByRole("heading", { name: "Related session" })).toBeVisible();
      expect(state.writes).toHaveLength(1);
    } finally { client.clear(); }
  });

  it("a rejected sheet Save keeps the selected note and exact edits without a route prompt", async () => {
    const { router, client, state } = mount(503);
    try {
      await edit();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(state.writes).toHaveLength(1));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(router.state.location.pathname + router.state.location.search).toBe(origin);
      expect(screen.getByDisplayValue("Reviewed title")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Reviewed body</p>");
      expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
    } finally { client.clear(); }
  });
});
