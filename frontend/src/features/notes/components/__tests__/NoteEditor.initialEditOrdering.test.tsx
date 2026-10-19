// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { fireEvent } from "@testing-library/react";
import { screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import i18n from "@/i18n/config";
import type { Note } from "@/types/note";
import { useNote } from "../../api/use-note-detail";

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
const apiPath = "/api/workspaces/acme/boards/board-1/notes/note-1";
const reviewedTitle = "Reviewed title";
const reviewedBody = "<p>Reviewed body</p>";
type EditPhase = "first-commit" | "settled";

function observe(context: TestContext) {
  const entries: Record<string, unknown>[] = [];
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;
  let dropped = 0;
  function identity(value: object | null) {
    if (!value) return null;
    if (!identities.has(value)) identities.set(value, ++nextIdentity);
    return identities.get(value);
  }
  function field(element: Element | null) {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? { identity: identity(element), connected: element.isConnected, value: element.value }
      : null;
  }
  function record(phase: string, detail: Record<string, unknown> = {}) {
    if (entries.length >= 80) { dropped += 1; return; }
    entries.push({ sequence: entries.length, phase, ...detail,
      title: field(document.querySelector('input[aria-label="Title"]')),
      body: field(document.querySelector('textarea[aria-label="Note body"]')) });
  }
  const state = { edits: 0, passiveObserved: false, source: null as Note | null };
  function capture(event: Event) {
    if (!(event.target instanceof HTMLInputElement) || event.target.getAttribute("aria-label") !== "Title") return;
    record(`native-${event.type}`, { target: field(event.target), trusted: event.isTrusted });
  }
  document.addEventListener("change", capture, true);
  document.addEventListener("input", capture, true);
  context.onTestFinished(() => {
    record("test-finished", { aborted: context.signal.aborted });
    document.removeEventListener("change", capture, true);
    document.removeEventListener("input", capture, true);
    console.info("A05_NOTE_INITIAL_EDIT_ORDER", JSON.stringify({ test: context.task.name, dropped, entries }));
  });
  return { entries, state, record, identity, field, dropped: () => dropped };
}
type Trace = ReturnType<typeof observe>;

function changeTitle(trace: Trace, phase: EditPhase) {
  const input = document.querySelector('input[aria-label="Title"]');
  if (!(input instanceof HTMLInputElement) || !input.isConnected) throw new Error("Initial title must be connected");
  trace.record("before-title-change", { editPhase: phase, sourceIdentity: trace.identity(trace.state.source), target: trace.field(input) });
  trace.state.edits += 1;
  fireEvent.change(input, { target: { value: reviewedTitle } });
  trace.record("after-title-change", { editPhase: phase, target: trace.field(input) });
}

function AuthorizedEditor({ phase, trace }: { phase: EditPhase; trace: Trace }) {
  const { data: source } = useNote("acme", note.id, "board-1");
  const [showEditor, setShowEditor] = useState(false);
  const [open, setOpen] = useState(true);
  useLayoutEffect(() => {
    if (!source || !showEditor) return;
    trace.state.source = source;
    trace.record("source-layout", { sourceIdentity: trace.identity(source), sourceTitle: source.title });
    // This sentinel fixes the committed-DOM/before-passive ordering. It is
    // not a claim about a trusted browser event occurring inside a commit.
    if (phase === "first-commit" && trace.state.edits === 0) changeTitle(trace, phase);
  }, [source, showEditor, phase, trace]);
  useEffect(() => {
    if (!source || !showEditor) return;
    // Descendant passive effects, including NoteEditor's source adoption,
    // precede this parent checkpoint; their queued updates can still be pending.
    trace.state.passiveObserved = true;
    trace.record("source-passive", { sourceIdentity: trace.identity(source), sourceTitle: source.title });
  }, [source, showEditor, trace]);
  return <>
    <button disabled={!source} onClick={() => setShowEditor(true)}>Open fetched note</button>
    {source && showEditor ? <NoteEditor note={source} slug="acme" boardId="board-1" open={open} onOpenChange={setOpen} /> : null}
  </>;
}

const fixtures: Array<ReturnType<typeof renderNavigationRouter> & { trace: Trace }> = [];
function mount(phase: EditPhase, trace: Trace) {
  const state = { saved: { ...note }, reads: 0, writes: [] as Record<string, unknown>[], unexpected: [] as string[] };
  server.use(
    http.get(apiPath, () => {
      state.reads += 1;
      trace.record("detail-http-response", { sourceTitle: state.saved.title });
      return HttpResponse.json(state.saved);
    }),
    http.put(apiPath, async ({ request }) => {
      const payload = await request.json() as Record<string, unknown>;
      state.writes.push(payload);
      trace.record("put-http-body", { payload });
      state.saved = { ...state.saved, ...payload, updated_at: "2026-10-18T04:01:00Z" };
      return HttpResponse.json(state.saved);
    }),
    http.all("/api/*", ({ request }) => {
      state.unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected initial-edit probe request" }, { status: 500 });
    }),
  );
  const rendered = renderNavigationRouter([
    { path: "/acme/boards/board-1/notes", element: <AuthorizedEditor phase={phase} trace={trace} /> },
  ], { initialEntries: ["/acme/boards/board-1/notes?note=note-1"] });
  fixtures.push({ ...rendered, trace });
  return { ...rendered, state };
}

beforeEach(async () => { stubReducedMotion(true); await i18n.changeLanguage("en"); });
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.trace.record("teardown-start");
    fixture.unmount();
    fixture.router.dispose();
    await fixture.client.cancelQueries();
    fixture.client.clear();
  }
  stubReducedMotion(false);
});

describe("NoteEditor initial edit ordering through its actual detail and mutation", () => {
  it.for(["first-commit", "settled"] as const)("preserves the %s title edit through body editing and Save", async (phase, context) => {
    const trace = observe(context);
    const { client, state } = mount(phase, trace);
    const open = await screen.findByRole("button", { name: "Open fetched note" });
    await waitFor(() => expect(open).toBeEnabled());
    fireEvent.click(open);
    await screen.findByRole("textbox", { name: "Title" });
    await waitFor(() => expect(trace.state.passiveObserved).toBe(true));
    if (phase === "settled") changeTitle(trace, phase);

    expect(trace.state.edits).toBe(1);
    expect(state.reads).toBe(1);
    expect(state.writes).toEqual([]);
    const layoutIndex = trace.entries.findIndex((entry) => entry.phase === "source-layout");
    const changeIndex = trace.entries.findIndex((entry) => entry.phase === "before-title-change");
    const passiveIndex = trace.entries.findIndex((entry) => entry.phase === "source-passive");
    expect(layoutIndex).toBeGreaterThanOrEqual(0);
    expect(layoutIndex).toBeLessThan(changeIndex);
    if (phase === "first-commit") expect(changeIndex).toBeLessThan(passiveIndex);
    else expect(changeIndex).toBeGreaterThan(passiveIndex);
    expect(trace.entries.filter((entry) => entry.phase === "native-change")).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ connected: true, value: reviewedTitle }), trusted: false }),
    ]);

    trace.record("before-body-change");
    fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: reviewedBody } });
    trace.record("after-body-change");
    // Continue to the exact PUT oracle even if the controlled title was reset.
    expect.soft(screen.getByRole("textbox", { name: "Title" })).toHaveValue(reviewedTitle);
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(reviewedBody);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(state.writes).toHaveLength(1));
    expect(state.writes).toEqual([{ title: reviewedTitle, content: reviewedBody }]);
    await waitFor(() => expect(client.isMutating()).toBe(0));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Note body" })).not.toBeInTheDocument());
    expect(state.writes).toHaveLength(1);
    expect(state.unexpected).toEqual([]);
    expect(trace.dropped()).toBe(0);
    trace.record("all-assertions-complete");
  });
});
