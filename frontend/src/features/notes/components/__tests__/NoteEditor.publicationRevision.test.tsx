// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { act, renderWithProviders, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { meKeys } from "@/lib/query-keys";
import type { ConnectionStatus, WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import i18n from "@/i18n/config";
import { SUPPORTED_LANGUAGES } from "@/i18n/supported-languages";
import type { Note } from "@/types/note";
import { NoteEditor } from "../NoteEditor";

// Keep the actual editor shell, metadata, current-user query, API client,
// mutations and publication query. Only replace the rich-text engine with a
// controlled field so draft/selection preservation has an observable seam.
vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Note content editor" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const SLUG = "publication-workspace";
const BOARD = "publication-board";
const OWNER = { id: "publishing-owner", name: "Synthetic owner", email: "owner@example.test", avatar_url: null };
const PUBLISHED = "a".repeat(64);
const DIFFERENT = "b".repeat(64);
const RECORDED_AT = "2026-10-18T04:23:45Z";
const clients: QueryClient[] = [];
const pending: Array<() => void> = [];
const originalWidth = window.innerWidth;

interface PublicationRevision {
  status: "recorded" | "no_record" | "revision_not_recorded" | "unsupported_version";
  recorded_at: string | null;
  revision_version: number | null;
  published_revision_sha256: string | null;
  current_revision_sha256: string | null;
  comparison: "matches" | "differs" | "unavailable" | null;
  comparison_reason: "current_note_too_large" | null;
}

function recorded(overrides: Partial<PublicationRevision> = {}): PublicationRevision {
  return { status: "recorded", recorded_at: RECORDED_AT, revision_version: 1,
    published_revision_sha256: PUBLISHED, current_revision_sha256: PUBLISHED,
    comparison: "matches", comparison_reason: null, ...overrides };
}

function unavailable(status: PublicationRevision["status"]): PublicationRevision {
  return { status, recorded_at: status === "no_record" ? null : RECORDED_AT,
    revision_version: null, published_revision_sha256: null, current_revision_sha256: null,
    comparison: null, comparison_reason: null };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return { id: "published-note", workspace_id: "destination-workspace", board_id: BOARD,
    card_id: null, title: "Published handoff", content: "<p>Saved handoff text</p>",
    pinned: false, kind: "user_note", failure_class: null, findings: null,
    source_execution_id: null, created_by: OWNER.id,
    created_at: "2026-10-17T01:00:00Z", updated_at: "2026-10-17T01:00:00Z", ...overrides };
}

function revisionPath(slug = SLUG, noteId = "published-note") {
  return `/api/workspaces/${slug}/boards/${BOARD}/notes/${noteId}/publication-revision`;
}

function presencePath(slug = SLUG, noteId = "published-note") {
  return `${revisionPath(slug, noteId)}/presence`;
}

// Fallbacks keep the first regression about the absent action, not absent
// catalog keys. The locale case separately requires real per-locale strings.
const fallbackCopy = {
  action: "Compare with original handoff", matches: "Matches publication revision",
  differs: "Differs from publication revision", noRecord: "No publication record",
  revisionNotRecorded: "Publication revision was not recorded",
  unsupportedVersion: "Publication revision version is not supported",
  currentNoteTooLarge: "The saved note is too large to compare",
  loadError: "Could not load publication revision", accessLost: "Publication revision is unavailable or access was lost",
  savedNoteScope: "Compares the saved note, not unsaved edits.",
  fieldScope: "Includes title, content, kind and pin state. Excludes card links and timestamps.",
  recordedAt: "Recorded at", details: "Details",
  publishedDigest: "Published revision", currentDigest: "Current saved revision",
  checkAgain: "Check again", loading: "Checking publication revision…",
};
type CopyKey = keyof typeof fallbackCopy;
function copy(key: CopyKey) {
  return String(i18n.t(`notes.publicationRevision.${key}`, { defaultValue: fallbackCopy[key] }));
}

function deferred() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  pending.push(release);
  return { ready, release };
}

function connection() {
  const subscriptions = new Set<{ pattern: string; handler: (event: WebSocketEvent) => void }>();
  const dispatch = (event: WebSocketEvent) => subscriptions.forEach(({ pattern, handler }) => {
    if (pattern === event.event || (pattern.endsWith(".*") && event.event.startsWith(pattern.slice(0, -1)))) handler(event);
  });
  return {
    status: "connected" as const,
    subscribe(pattern: string, handler: (event: WebSocketEvent) => void) {
      const subscription = { pattern, handler };
      subscriptions.add(subscription);
      return () => { subscriptions.delete(subscription); };
    },
    noteUpdated(noteId = "published-note") {
      const event = { event: "activity.note.updated", event_id: "synthetic-note-update",
        timestamp: "2026-10-18T05:00:00Z", payload: { entity_id: noteId, board_id: BOARD, action: "updated" } };
      dispatch(event);
    },
    memberChanged(userId: string, action: "removed_member" | "updated") {
      dispatch({ event: `activity.member.${action}`, event_id: "synthetic-membership-update", timestamp: "2026-10-18T05:00:00Z",
        payload: { entity_type: "member", entity_id: userId, action, actor_id: "workspace-admin", board_id: null,
          summary: "Synthetic membership change", message_key: action === "updated" ? "activity.member.role_changed" : "activity.member.removed",
          message_params: action === "updated" ? { member_email: OWNER.email, role: "viewer", previous_role: "member" } : {},
          changes: { affected_user_id: userId } } });
    },
  };
}

function setup(options: { note?: Note; userId?: string; identityPending?: boolean; hasRecord?: boolean; presenceStatus?: number; response?: PublicationRevision; status?: number; allowPinUpdate?: boolean; workspaceRoute?: boolean } = {}) {
  const note = options.note ?? makeNote();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } });
  clients.push(client);
  const identity = deferred();
  if (!options.identityPending) {
    identity.release();
    client.setQueryData(meKeys.me(), { ...OWNER, id: options.userId ?? OWNER.id });
  }
  const defaultHasRecord = options.hasRecord ?? (options.response?.status !== "no_record");
  const state = {
    hasRecord: defaultHasRecord,
    presenceStatus: options.presenceStatus ?? 200,
    presenceRequests: [] as string[],
    presenceNextGate: null as ReturnType<typeof deferred> | null,
    response: options.response ?? recorded(), status: options.status ?? 200,
    revisionRequests: [] as string[], unexpected: [] as string[], routineRequests: [] as string[],
    pinUpdates: [] as unknown[],
    members: [{ user_id: OWNER.id, name: OWNER.name, email: OWNER.email, role: "member" }],
    membersStatus: 200,
    nextGate: null as ReturnType<typeof deferred> | null,
  };
  server.use(http.all("/api/*", async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/publication-revision/presence")) {
      state.presenceRequests.push(path);
      const status = state.presenceStatus;
      const hasRecord = state.hasRecord;
      const gate = state.presenceNextGate;
      state.presenceNextGate = null;
      await gate?.ready;
      return HttpResponse.json(
        status === 200
          ? { has_record: hasRecord, recorded_at: hasRecord ? RECORDED_AT : null }
          : { detail: "Synthetic presence request rejected" },
        { status },
      );
    }
    if (request.method === "GET" && path.endsWith("/publication-revision")) {
      state.revisionRequests.push(path);
      const response = structuredClone(state.response);
      const status = state.status;
      const gate = state.nextGate;
      state.nextGate = null;
      await gate?.ready;
      return HttpResponse.json(status === 200 ? response : { detail: "Synthetic request rejected" }, { status });
    }
    state.routineRequests.push(`${request.method} ${path}`);
    if (options.allowPinUpdate && request.method === "PUT" && path === (options.workspaceRoute
      ? `/api/workspaces/${SLUG}/notes/${note.id}`
      : `/api/workspaces/${SLUG}/boards/${BOARD}/notes/${note.id}`)) {
      const payload: unknown = await request.json();
      state.pinUpdates.push(payload);
      expect(payload).toEqual({ pinned: true });
      state.response = recorded({ comparison: "differs", current_revision_sha256: DIFFERENT });
      return HttpResponse.json({ ...note, pinned: true });
    }
    if (request.method === "GET") {
      if (path === "/api/me") {
        await identity.ready;
        return HttpResponse.json({ ...OWNER, id: options.userId ?? OWNER.id });
      }
      if (path === "/api/auth/modes") return HttpResponse.json({ companion_enabled: false, password_enabled: false, dev_mode: false });
      if (/\/members$/.test(path)) return HttpResponse.json(state.membersStatus === 200 ? state.members : { detail: "Synthetic destination access denied" }, { status: state.membersStatus });
      if (/\/boards\/publication-board$/.test(path)) return HttpResponse.json({ id: BOARD, name: "Synthetic board", columns: [] });
      if (path.endsWith("/config/completion-context-impact")) return HttpResponse.json({ attempts: [] });
    }
    state.unexpected.push(`${request.method} ${path}`);
    return HttpResponse.json({ detail: "Unexpected request in publication inspection" }, { status: 400 });
  }));
  const socket = connection();
  const onOpenChange = vi.fn();
  const view = (nextNote = note, slug = SLUG, status: ConnectionStatus = "connected") => <WebSocketContext.Provider value={{ ...socket, status }}>
    <NoteEditor note={nextNote} slug={slug} boardId={options.workspaceRoute ? undefined : nextNote.board_id ?? undefined} open onOpenChange={onOpenChange} />
  </WebSocketContext.Provider>;
  const rendered = renderWithProviders(view(), { queryClient: client });
  return { ...rendered, state, client, socket, identity, onOpenChange,
    switchNote: (nextNote: Note, slug = SLUG) => rendered.rerender(view(nextNote, slug)),
    setSocketStatus: (status: ConnectionStatus) => rendered.rerender(view(note, SLUG, status)) };
}

async function openPublication() {
  const action = await screen.findByRole("button", { name: copy("action") });
  fireEvent.click(action);
  return action;
}

async function settled(client: QueryClient) {
  await waitFor(() => expect(client.isFetching()).toBe(0));
}

function expectReadOnly(state: ReturnType<typeof setup>["state"]) {
  expect(state.unexpected).toEqual([]);
  expect(state.routineRequests.every((request) => request.startsWith("GET "))).toBe(true);
}

beforeEach(async () => {
  stubReducedMotion(true);
  localStorage.removeItem("sheet-width:note-editor");
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  cleanup();
  pending.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
  stubReducedMotion(false);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
  localStorage.removeItem("sheet-width:note-editor");
  await i18n.changeLanguage("en");
});

describe("NoteEditor publication revision — deliberate saved-note inspection", () => {
  it("renders no comparison action for an ordinary UI or MCP note with no publication record", async () => {
    const { state, client } = setup({
      note: makeNote({ id: "ordinary-note", title: "Ordinary note" }),
      hasRecord: false,
      response: unavailable("no_record"),
    });
    await settled(client);
    expect(screen.queryByRole("button", { name: /Compare with original handoff|Publication revision|Check original publication/i })).not.toBeInTheDocument();
    expect(state.presenceRequests).toEqual([presencePath(SLUG, "ordinary-note")]);
    expect(state.revisionRequests).toEqual([]);
    expectReadOnly(state);
  });

  it("does not silently treat a failed presence query as 'no record' or prefetch the comparison body", async () => {
    const { state, client } = setup({ presenceStatus: 503 });
    await settled(client);
    expect(state.presenceRequests).toEqual([presencePath()]);
    expect(state.revisionRequests).toEqual([]);
    expect(screen.queryByText(copy("noRecord"))).not.toBeInTheDocument();
    expect(screen.getByText(copy("loadError"))).toBeVisible();
    expectReadOnly(state);
  });

  it("offers the publishing owner an explicit Compare with original handoff action after presence check and performs no revision read before it", async () => {
    const { state, client } = setup();
    await settled(client);
    expect(state.presenceRequests).toEqual([presencePath()]);
    expect(state.revisionRequests).toEqual([]);
    const action = screen.getByRole("button", { name: "Compare with original handoff" });
    expect(action).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(action);
    expect(await screen.findByText(copy("matches"))).toBeVisible();
    expect(state.revisionRequests).toEqual([revisionPath()]);
    expectReadOnly(state);
  });

  it("does not infer publishing ownership from shared note visibility", async () => {
    const { state, client } = setup({ userId: "shared-note-recipient" });
    await settled(client);
    expect(screen.getByDisplayValue("Published handoff")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Compare with original handoff|Publication revision/i })).not.toBeInTheDocument();
    expect(state.presenceRequests).toEqual([]);
    expect(state.revisionRequests).toEqual([]);
    expectReadOnly(state);
  });

  it("waits for current identity before checking presence or offering the owner action without prefetching proof", async () => {
    const { state, identity, client } = setup({ identityPending: true });
    expect(screen.queryByRole("button", { name: /Compare with original handoff|Publication revision/i })).not.toBeInTheDocument();
    expect(state.presenceRequests).toEqual([]);
    expect(state.revisionRequests).toEqual([]);
    await act(async () => { identity.release(); });
    expect(await screen.findByRole("button", { name: "Compare with original handoff" })).toBeVisible();
    await settled(client);
    expect(state.presenceRequests).toEqual([presencePath()]);
    expect(state.revisionRequests).toEqual([]);
  });

  it("shows saved-note scope immediately and reveals hashes only through Details without a misleading revision-history counter", async () => {
    const { state } = setup({ response: recorded({ comparison: "differs", current_revision_sha256: DIFFERENT }) });
    await openPublication();
    expect(await screen.findByText(copy("differs"))).toBeVisible();
    expect(screen.getByText(copy("savedNoteScope"))).toBeVisible();
    for (const digest of [PUBLISHED, DIFFERENT]) {
      screen.queryAllByText(digest, { exact: true }).forEach((element) => expect(element).not.toBeVisible());
    }
    fireEvent.click(screen.getByText(copy("details"), { exact: true }));
    expect(screen.getByText(PUBLISHED, { exact: true })).toBeVisible();
    expect(screen.getByText(DIFFERENT, { exact: true })).toBeVisible();
    expect(screen.getByText(copy("fieldScope"))).toBeVisible();
    expect(screen.getByText(copy("recordedAt"), { exact: true })).toBeVisible();
    expect(screen.queryByText("Revision version", { exact: true })).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/never edited|human.reviewed|model.used|approved analysis/i);
    expectReadOnly(state);
  });

  it("reports match, difference, then restored match using the server comparison despite unchanged note props", async () => {
    const { state } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    state.response = recorded({ comparison: "differs", current_revision_sha256: DIFFERENT });
    fireEvent.click(screen.getByRole("button", { name: copy("checkAgain") }));
    await screen.findByText(copy("differs"));
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    state.response = recorded();
    fireEvent.click(screen.getByRole("button", { name: copy("checkAgain") }));
    await screen.findByText(copy("matches"));
    expect(screen.queryByText(copy("differs"))).not.toBeInTheDocument();
    expect(state.revisionRequests).toEqual([revisionPath(), revisionPath(), revisionPath()]);
    expectReadOnly(state);
  });

  it.each([
    ["no record", unavailable("no_record"), "noRecord"],
    ["legacy or incomplete revision", unavailable("revision_not_recorded"), "revisionNotRecorded"],
    ["unsupported version", { ...unavailable("unsupported_version"), revision_version: 99 }, "unsupportedVersion"],
    ["oversized current note", recorded({ current_revision_sha256: null, comparison: "unavailable", comparison_reason: "current_note_too_large" }), "currentNoteTooLarge"],
  ] as const)("distinguishes %s without claiming a match or a difference", async (_label, response, messageKey) => {
    const { state } = setup({ hasRecord: true, response });
    await openPublication();
    expect(await screen.findByText(copy(messageKey))).toBeVisible();
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(screen.queryByText(copy("differs"))).not.toBeInTheDocument();
    expect(state.revisionRequests).toEqual([revisionPath()]);
    expectReadOnly(state);
  });

  it("shows loading and a transient error, then retries only on deliberate action", async () => {
    const { state, client } = setup({ status: 503 });
    const gate = deferred();
    state.nextGate = gate;
    await openPublication();
    await waitFor(() => expect(state.revisionRequests).toHaveLength(1));
    expect(screen.getByText(copy("loading"))).toBeVisible();
    await act(async () => { gate.release(); });
    expect(await screen.findByText(copy("loadError"))).toBeVisible();
    await settled(client);
    expect(state.revisionRequests).toHaveLength(1);
    state.status = 200;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(copy("matches"))).toBeVisible();
    expect(state.revisionRequests).toHaveLength(2);
    expectReadOnly(state);
  });

  it.each([403, 404])("purges previously displayed and cached proof after definitive HTTP %i", async (status) => {
    const { state, client } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    fireEvent.click(screen.getByText(copy("details"), { exact: true }));
    expect(screen.getAllByText(PUBLISHED, { exact: true }).some((element) => element.textContent === PUBLISHED)).toBe(true);
    state.status = status;
    fireEvent.click(screen.getByRole("button", { name: copy("checkAgain") }));
    expect(await screen.findByText(copy("accessLost"))).toBeVisible();
    await settled(client);
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(screen.queryAllByText(PUBLISHED, { exact: true })).toHaveLength(0);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(PUBLISHED);
    expectReadOnly(state);
  });

  it.each(["note", "workspace"] as const)("ignores a late success after a %s switch and does not inspect the new destination automatically", async (switchKind) => {
    const { state, client, switchNote } = setup();
    const gate = deferred();
    state.nextGate = gate;
    await openPublication();
    await waitFor(() => expect(state.revisionRequests).toHaveLength(1));
    const nextNote = switchKind === "note" ? makeNote({ id: "second-note", title: "Second note" }) : makeNote();
    const nextSlug = switchKind === "workspace" ? "second-workspace" : SLUG;
    switchNote(nextNote, nextSlug);
    await act(async () => { gate.release(); });
    await settled(client);
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(screen.queryAllByText(PUBLISHED, { exact: true })).toHaveLength(0);
    expect(state.revisionRequests).toEqual([revisionPath()]);
    state.response = unavailable("no_record");
    await openPublication();
    expect(await screen.findByText(copy("noRecord"))).toBeVisible();
    expect(state.revisionRequests).toEqual([revisionPath(), revisionPath(nextSlug, nextNote.id)]);
    expectReadOnly(state);
  });

  it("does not resurrect proof when an older successful response arrives after a committed-event recheck denies access", async () => {
    const { state, client, socket } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    const oldSuccess = deferred();
    state.nextGate = oldSuccess;
    fireEvent.click(screen.getByRole("button", { name: copy("checkAgain") }));
    await waitFor(() => expect(state.revisionRequests).toHaveLength(2));
    state.status = 403;
    act(() => { socket.noteUpdated(); });
    expect(await screen.findByText(copy("accessLost"))).toBeVisible();
    expect(state.revisionRequests).toHaveLength(3);
    await act(async () => { oldSuccess.release(); });
    await settled(client);
    expect(screen.getByText(copy("accessLost"))).toBeVisible();
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(screen.queryAllByText(PUBLISHED, { exact: true })).toHaveLength(0);
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(PUBLISHED);
    expectReadOnly(state);
  });

  it("preserves dirty text, focus, selection and the close guard when an inspection response arrives", async () => {
    const { state, onOpenChange } = setup();
    const title = screen.getByDisplayValue("Published handoff");
    const editor = screen.getByRole("textbox", { name: "Note content editor" }) as HTMLTextAreaElement;
    fireEvent.change(title, { target: { value: "Unpublished local title" } });
    fireEvent.change(editor, { target: { value: "Unpublished local body" } });
    const gate = deferred();
    state.nextGate = gate;
    await openPublication();
    await waitFor(() => expect(state.revisionRequests).toHaveLength(1));
    editor.focus();
    editor.setSelectionRange(3, 10);
    await act(async () => { gate.release(); });
    expect(await screen.findByText(copy("matches"))).toBeVisible();
    expect(title).toHaveValue("Unpublished local title");
    expect(editor).toHaveValue("Unpublished local body");
    expect(editor).toHaveFocus();
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([3, 10]);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("unsaved-changes-prompt")).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    expectReadOnly(state);
  });

  it("uses committed note events to refresh an open comparison without replacing a dirty draft", async () => {
    const { state, socket } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    const editor = screen.getByRole("textbox", { name: "Note content editor" });
    fireEvent.change(editor, { target: { value: "Keep this local draft" } });
    state.response = recorded({ comparison: "differs", current_revision_sha256: DIFFERENT });
    act(() => { socket.noteUpdated(); });
    expect(await screen.findByText(copy("differs"))).toBeVisible();
    expect(editor).toHaveValue("Keep this local draft");
    expect(state.revisionRequests).toHaveLength(2);
    expectReadOnly(state);
  });

  it("does not turn a note event into a publication read before the owner opens the disclosure", async () => {
    const { state, socket, client } = setup();
    await settled(client);
    await act(async () => {
      socket.noteUpdated();
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await settled(client);
    expect(state.revisionRequests).toEqual([]);
    expectReadOnly(state);
  });

  it("rechecks the saved revision after a pin succeeds while the first comparison is pending, without needing a websocket event", async () => {
    const { state, client } = setup({ allowPinUpdate: true });
    const firstComparison = deferred();
    state.nextGate = firstComparison;
    await openPublication();
    await waitFor(() => expect(state.revisionRequests).toEqual([revisionPath()]));
    expect(screen.getByText(copy("loading"))).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: String(i18n.t("notes.pin")) }));
    await screen.findByRole("button", { name: String(i18n.t("notes.unpin")) });
    expect(state.pinUpdates).toEqual([{ pinned: true }]);
    await act(async () => { firstComparison.release(); });

    expect(await screen.findByText(copy("differs"))).toBeVisible();
    await settled(client);
    expect(state.revisionRequests).toEqual([revisionPath(), revisionPath()]);
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(state.unexpected).toEqual([]);
    expect(state.routineRequests.filter((request) => !request.startsWith("GET "))).toEqual([
      `PUT /api/workspaces/${SLUG}/boards/${BOARD}/notes/published-note`,
    ]);
  });

  it("recovers an open saved-note comparison after websocket reconnect while HTTP stays online", async () => {
    const { state, client, setSocketStatus } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    await settled(client);
    expect(state.revisionRequests).toEqual([revisionPath()]);

    setSocketStatus("disconnected");
    state.response = recorded({ comparison: "differs", current_revision_sha256: DIFFERENT });
    expect(state.revisionRequests).toEqual([revisionPath()]);
    setSocketStatus("connected");

    expect(await screen.findByText(copy("differs"))).toBeVisible();
    await settled(client);
    expect(state.revisionRequests).toEqual([revisionPath(), revisionPath()]);
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it.each(["settled", "pending"])("rechecks a board note pinned from the workspace route while disconnected with a %s comparison", async (comparison) => {
    const { state, client, setSocketStatus } = setup({ allowPinUpdate: true, workspaceRoute: true });
    setSocketStatus("disconnected");
    const firstComparison = deferred();
    if (comparison === "pending") state.nextGate = firstComparison;
    await openPublication();
    await waitFor(() => expect(state.revisionRequests).toEqual([revisionPath()]));
    if (comparison === "settled") await screen.findByText(copy("matches"));
    const editor = screen.getByRole("textbox", { name: "Note content editor" });
    fireEvent.change(editor, { target: { value: "Keep workspace-route draft" } });

    fireEvent.click(screen.getByRole("button", { name: String(i18n.t("notes.pin")) }));
    await screen.findByRole("button", { name: String(i18n.t("notes.unpin")) });
    expect(state.pinUpdates).toEqual([{ pinned: true }]);
    await act(async () => { firstComparison.release(); });

    expect(await screen.findByText(copy("differs"))).toBeVisible();
    await settled(client);
    expect(state.revisionRequests).toEqual([revisionPath(), revisionPath()]);
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(editor).toHaveValue("Keep workspace-route draft");
    expect(state.unexpected).toEqual([]);
    expect(state.routineRequests.filter((request) => !request.startsWith("GET "))).toEqual([
      `PUT /api/workspaces/${SLUG}/notes/published-note`,
    ]);
  });

  it("rechecks and purges proof when this publishing owner's membership is removed, even if an older success is pending", async () => {
    const { state, socket, client } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    const oldSuccess = deferred();
    state.nextGate = oldSuccess;
    fireEvent.click(screen.getByRole("button", { name: copy("checkAgain") }));
    await waitFor(() => expect(state.revisionRequests).toHaveLength(2));
    state.members = [];
    state.status = 403;

    act(() => { socket.memberChanged(OWNER.id, "removed_member"); });
    expect(await screen.findByText(copy("accessLost"))).toBeVisible();
    expect(state.revisionRequests).toHaveLength(3);
    await act(async () => { oldSuccess.release(); });
    await settled(client);
    expect(screen.getByText(copy("accessLost"))).toBeVisible();
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(PUBLISHED);
    expectReadOnly(state);
  });

  it("does not recheck a private publication receipt for another member's removal", async () => {
    const { state, socket, client } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    await act(async () => {
      socket.memberChanged("another-member", "removed_member");
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    await settled(client);
    expect(state.revisionRequests).toEqual([revisionPath()]);
    expect(screen.getByText(copy("matches"))).toBeVisible();
    expectReadOnly(state);
  });

  it("rechecks an owner-targeted viewer-role change without treating reduced write permission as lost read access", async () => {
    const { state, socket, client } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    state.members = [{ user_id: OWNER.id, name: OWNER.name, email: OWNER.email, role: "viewer" }];

    act(() => { socket.memberChanged(OWNER.id, "updated"); });
    await waitFor(() => expect(state.revisionRequests).toEqual([revisionPath(), revisionPath()]));
    await settled(client);
    expect(screen.getByText(copy("matches"))).toBeVisible();
    expect(screen.queryByText(copy("accessLost"))).not.toBeInTheDocument();
    expectReadOnly(state);
  });

  it("purges publication proof after a definitive roster denial even when the triggering event targets another member", async () => {
    const { state, socket, client } = setup();
    await openPublication();
    await screen.findByText(copy("matches"));
    fireEvent.click(screen.getByText(copy("details"), { exact: true }));
    expect(screen.getAllByText(PUBLISHED, { exact: true })).not.toHaveLength(0);
    await settled(client);
    const membersPath = `GET /api/workspaces/${SLUG}/members`;
    const previousMemberReads = state.routineRequests.filter((request) => request === membersPath).length;
    state.membersStatus = 403;

    act(() => { socket.memberChanged("another-member", "removed_member"); });
    await waitFor(() => expect(state.routineRequests.filter((request) => request === membersPath)).toHaveLength(previousMemberReads + 1));
    await settled(client);
    await waitFor(() => expect(screen.queryAllByText(PUBLISHED, { exact: true })).toHaveLength(0));
    expect(screen.queryByText(copy("matches"))).not.toBeInTheDocument();
    expect(screen.queryByText(copy("differs"))).not.toBeInTheDocument();
    await waitFor(() => expect(JSON.stringify(client.getQueryCache().getAll().map((query) => query.state.data))).not.toContain(PUBLISHED));
    expect(state.revisionRequests).toEqual([revisionPath()]);
    expectReadOnly(state);
  });

  it.each([375, 1440])("supports keyboard disclosure at viewport %i without changing stored sheet width or taking focus", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    localStorage.setItem("sheet-width:note-editor", "1100");
    setup();
    const dialog = screen.getByRole("dialog");
    const initialWidth = dialog.style.width;
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const action = await screen.findByRole("button", { name: "Compare with original handoff" });
    action.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText(copy("matches"))).toBeVisible();
    expect(action).toHaveAttribute("aria-expanded", "true");
    expect(action).toHaveFocus();
    expect(dialog.style.width).toBe(initialWidth);
    expect(localStorage.getItem("sheet-width:note-editor")).toBe("1100");
    await user.keyboard("{Enter}");
    expect(action).toHaveAttribute("aria-expanded", "false");
    expect(action).toHaveFocus();
  });

  it.each(SUPPORTED_LANGUAGES)("renders the real %s catalog with every publication state and detail translated", async (language) => {
    await i18n.changeLanguage(language);
    const { state } = setup();
    expect(i18n.getResource("en", "translation", "notes.publicationRevision.action")).toBe("Compare with original handoff");
    await openPublication();
    expect(await screen.findByText(copy("matches"))).toBeVisible();
    for (const key of Object.keys(fallbackCopy) as CopyKey[]) {
      const value: unknown = i18n.getResource(language, "translation", `notes.publicationRevision.${key}`);
      expect(value, `${language}: ${key}`).toEqual(expect.any(String));
      expect(String(value).trim(), `${language}: ${key}`).not.toBe("");
      if (language !== "en") {
        expect(value, `${language}: ${key} must not silently use English`).not.toBe(i18n.getResource("en", "translation", `notes.publicationRevision.${key}`));
      }
    }
    expect(document.body.textContent).not.toContain("notes.publicationRevision.");
    expectReadOnly(state);
  });
});
