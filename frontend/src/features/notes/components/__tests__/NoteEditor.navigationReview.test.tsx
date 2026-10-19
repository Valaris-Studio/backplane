// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import type { Note } from "@/types/note";
import { noteKeys } from "@/lib/query-keys";

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

function diagnostic(context: TestContext) {
  const started = performance.now();
  const entries: Record<string, unknown>[] = [];
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;
  let dropped = 0;
  let inspectSource: () => unknown = () => null;
  let unsubscribe = () => {};
  function identity(value: object | null | undefined) {
    if (!value) return null;
    if (!identities.has(value)) identities.set(value, ++nextIdentity);
    return identities.get(value);
  }
  function field(element: Element | null) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? { identity: identity(element), connected: element.isConnected, value: element.value,
        label: element.getAttribute("aria-label"), focused: document.activeElement === element }
      : null;
  }
  function record(phase: string, detail: Record<string, unknown> = {}) {
    if (entries.length >= 200) { dropped += 1; return; }
    entries.push({ at: performance.now() - started, phase, ...detail,
      title: field(document.querySelector('[role="dialog"] input[type="text"]')),
      body: field(document.querySelector('textarea[aria-label="Note body"]')),
      source: inspectSource() });
  }
  function observeEvent(event: Event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      || !target.closest('[role="dialog"]')) return;
    record(`native-${event.type}-capture`, { target: field(target), trusted: event.isTrusted });
  }
  document.addEventListener("change", observeEvent, true);
  document.addEventListener("input", observeEvent, true);
  context.onTestFinished(() => {
    record("test-finished", { aborted: context.signal.aborted });
    document.removeEventListener("change", observeEvent, true);
    document.removeEventListener("input", observeEvent, true);
    unsubscribe();
    console.info("A05_NOTE_SAVE_DIAGNOSTIC", JSON.stringify({ test: context.task.name, dropped, entries }));
  });
  return { record, field, identity,
    observeSource: (read: () => unknown, stop: () => void) => { inspectSource = read; unsubscribe = stop; } };
}

function mount(context: TestContext, status = 200) {
  const trace = diagnostic(context);
  const state = { saved: { ...note }, writes: [] as Record<string, unknown>[] };
  server.use(
    http.get(apiPath, () => HttpResponse.json([], { headers: { "X-Total-Count": "0" } })),
    http.get(`${apiPath}/note-1`, () => {
      trace.record("detail-http-response", { saved: { ...state.saved } });
      return HttpResponse.json(state.saved);
    }),
    http.put(`${apiPath}/note-1`, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push(payload);
      trace.record("put-http-body", { payload });
      if (status !== 200) return HttpResponse.json({ detail: "Save failed" }, { status });
      state.saved = { ...state.saved, ...payload, updated_at: "2026-10-18T04:01:00Z" };
      return HttpResponse.json(state.saved);
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/acme/boards/board-1/notes", element: <Profiler id="note-list" onRender={(_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
      trace.record("react-commit", { commitPhase: phase, actualDuration, baseDuration, startTime, commitTime });
    }}><NoteList slug="acme" boardId="board-1" /></Profiler> },
    { path: "/acme/sessions/session-1", element: <h1>Related session</h1> },
  ], { initialEntries: [origin] });
  const unsubscribe = rendered.client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== "note-detail") return;
    trace.record("detail-query-event", { type: event.type,
      action: event.type === "updated" ? event.action.type : null });
  });
  trace.observeSource(() => {
    const query = rendered.client.getQueryState<Note>(noteKeys.detail("acme", "note-1"));
    return { dataIdentity: trace.identity(query?.data), data: query?.data ? { ...query.data } : null,
      status: query?.status, fetchStatus: query?.fetchStatus, dataUpdatedAt: query?.dataUpdatedAt,
      route: rendered.router.state.location.pathname + rendered.router.state.location.search };
  }, unsubscribe);
  trace.record("mounted");
  return { ...rendered, state, trace };
}

async function edit(trace: ReturnType<typeof diagnostic>) {
  const title = await screen.findByDisplayValue("Saved title");
  trace.record("before-title-change", { target: trace.field(title) });
  fireEvent.change(title, { target: { value: "Reviewed title" } });
  trace.record("after-title-change", { target: trace.field(title) });
  fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "<p>Reviewed body</p>" } });
  trace.record("after-body-change", { titleTarget: trace.field(title) });
}
beforeEach(() => { stubReducedMotion(true); });
afterEach(() => { stubReducedMotion(false); });

describe("NoteEditor approved modal close through the real note query", () => {
  it.for(["sheet Save", "modal Save"])("%s closes the saved deep link without reopening a route guard", async (action, context) => {
    const { router, client, state, trace } = mount(context);
    const user = userEvent.setup();
    try {
      await edit(trace);
      trace.record("before-save-action", { action });
      if (action === "modal Save") {
        await user.keyboard("{Escape}");
        await user.click(screen.getByTestId("unsaved-changes-save"));
      } else {
        await user.click(screen.getByRole("button", { name: "Save" }));
      }
      trace.record("after-save-action", { action });
      await waitFor(() => expect(state.writes).toEqual([{ title: "Reviewed title", content: "<p>Reviewed body</p>" }]));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect(router.state.location.pathname + router.state.location.search).toBe(listPath);
      expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note body" })).not.toBeInTheDocument());
      await act(async () => { await router.navigate("/acme/sessions/session-1"); });
      expect(screen.getByRole("heading", { name: "Related session" })).toBeVisible();
      expect(state.writes).toHaveLength(1);
      trace.record("all-assertions-complete");
    } finally { trace.record("before-client-clear", { writes: state.writes }); client.clear(); }
  });

  it("a rejected sheet Save keeps the selected note and exact edits without a route prompt", async (context) => {
    const { router, client, state, trace } = mount(context, 503);
    try {
      await edit(trace);
      trace.record("before-save-action", { action: "rejected sheet Save" });
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      trace.record("after-save-action", { action: "rejected sheet Save" });
      await waitFor(() => expect(state.writes).toHaveLength(1));
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(router.state.location.pathname + router.state.location.search).toBe(origin);
      expect(screen.getByDisplayValue("Reviewed title")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Reviewed body</p>");
      expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
      trace.record("all-assertions-complete");
    } finally { trace.record("before-client-clear", { writes: state.writes }); client.clear(); }
  });
});
