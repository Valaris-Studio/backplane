// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { useNavigate } from "react-router-dom";
import { act, screen, stubReducedMotion, userEvent } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import type { Note } from "@/types/note";

const update = vi.fn();
vi.mock("../../api/use-notes", () => ({
  useUpdateNote: () => ({ mutate: update, isPending: false }),
  useDeleteNote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../NoteEditorMeta", () => ({ NoteEditorMeta: () => null }));
vi.mock("@/features/kanban/components/CompletionContextWarning", () => ({ CompletionContextWarning: () => null }));
vi.mock("@/features/sessions/components/LinkedSessionsSection", () => ({ NoteSessionsSection: () => null }));
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Note body" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));
import { NoteEditor } from "../NoteEditor";

const note: Note = {
  id: "note-1", workspace_id: "workspace-1", board_id: "board-1", card_id: null,
  title: "Saved title", content: "<p>Saved body</p>", pinned: false, kind: "user_note",
  failure_class: null, findings: null, source_execution_id: null, created_by: "owner-1",
  created_at: "2026-10-18T04:00:00Z", updated_at: "2026-10-18T04:00:00Z",
};
const origin = "/acme/boards/board-1/notes?note=note-1&sort=updated";
function EditorRoute() {
  const navigate = useNavigate();
  return <NoteEditor note={note} slug="acme" boardId="board-1" open onOpenChange={(open) => { if (!open) void navigate("/acme/boards/board-1/notes"); }} />;
}
function mount(forward = false) {
  return renderNavigationRouter([
    { path: "/acme/boards/board-1/notes", element: <EditorRoute /> },
    { path: "/acme/sessions/session-1", element: <h1>Related evidence</h1> },
  ], { initialEntries: forward ? [origin, "/acme/sessions/session-1"] : ["/acme/sessions/session-1", origin], initialIndex: forward ? 0 : 1 });
}
function edit() {
  fireEvent.change(screen.getByDisplayValue("Saved title"), { target: { value: "Unsaved title" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "<p>Unsaved body</p>" } });
}
beforeEach(() => { update.mockReset(); stubReducedMotion(true); });
afterEach(() => stubReducedMotion(false));

describe("NoteEditor route departure", () => {
  it.each(["Back", "Forward", "route push"])("blocks %s and lets Cancel keep the exact title and body without a write", async (departure) => {
    const { router } = mount(departure === "Forward");
    edit();
    await act(async () => { if (departure === "route push") await router.navigate("/acme/sessions/session-1"); else await router.navigate(departure === "Back" ? -1 : 1); });

    expect(router.state.location.pathname + router.state.location.search).toBe(origin);
    expect(screen.getByTestId("unsaved-changes-prompt")).toBeVisible();
    await userEvent.click(screen.getByTestId("unsaved-changes-keep-editing"));
    expect(screen.getByDisplayValue("Unsaved title")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Unsaved body</p>");
    expect(update).not.toHaveBeenCalled();
  });

  it("Save waits for success; failure retains edits and a retry can finish the original departure", async () => {
    const { router } = mount();
    edit();
    await act(async () => { await router.navigate("/acme/sessions/session-1"); });
    expect(router.state.location.pathname + router.state.location.search).toBe(origin);
    await userEvent.click(screen.getByTestId("unsaved-changes-save"));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toEqual({ noteId: "note-1", title: "Unsaved title", content: "<p>Unsaved body</p>" });
    expect(router.state.location.pathname + router.state.location.search).toBe(origin);

    await act(async () => { update.mock.calls[0]![1]?.onError?.(new Error("save rejected")); });
    expect(screen.getByDisplayValue("Unsaved title")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Unsaved body</p>");
    expect(router.state.location.pathname + router.state.location.search).toBe(origin);

    await act(async () => { await router.navigate("/acme/sessions/session-1"); });
    await userEvent.click(screen.getByTestId("unsaved-changes-save"));
    expect(update).toHaveBeenCalledTimes(2);
    await act(async () => { update.mock.calls[1]![1].onSuccess(); });
    expect(router.state.location.pathname).toBe("/acme/sessions/session-1");
  });

  it("Discard completes the blocked POP and Forward reopens the saved note without a write", async () => {
    const { router } = mount();
    edit();
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname + router.state.location.search).toBe(origin);
    await userEvent.click(screen.getByTestId("unsaved-changes-discard"));
    expect(router.state.location.pathname).toBe("/acme/sessions/session-1");
    expect(router.state.historyAction).toBe("POP");
    await act(async () => { await router.navigate(1); });
    expect(screen.getByDisplayValue("Saved title")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Saved body</p>");
    expect(update).not.toHaveBeenCalled();
  });

  it("warns on reload while dirty without serializing note text", () => {
    mount();
    edit();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(JSON.stringify(window.history.state)).not.toContain("Unsaved");
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain("Unsaved");
    expect(update).not.toHaveBeenCalled();
  });

  it("leaves a clean editor through Back without asking or writing", async () => {
    const { router } = mount();
    await act(async () => { await router.navigate(-1); });
    expect(screen.getByRole("heading", { name: "Related evidence" })).toBeVisible();
    expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});
