// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { act, screen, stubReducedMotion, userEvent, waitFor, within } from "@/test/test-utils";
import { renderNavigationRouter } from "@/test/navigation-router";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketProvider } from "@/providers/WebSocketProvider";
import i18n from "@/i18n/config";
import { SUPPORTED_LANGUAGES } from "@/i18n/supported-languages";
import { noteKeys, workspaceKeys } from "@/lib/query-keys";
import { makeNote, revision } from "@/features/notes/components/__tests__/note-history-fixtures";
import { WorkspaceNotesPage } from "../WorkspaceNotesPage";
import { WorkspaceLayout } from "../WorkspaceLayout";

vi.mock("@/components/shared/RichTextEditor", () => ({
  RichTextEditor: ({ content, onChange }: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Note body" value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

const SLUG = "revocation-fixture";
const VIEWER = { id: "fixture-viewer", name: "Fixture viewer", email: "viewer@example.test", avatar_url: null };
const TITLE = "Restricted fixture note";
const BODY = "<p>Restricted current body</p>";
const HISTORY_BODY = "Restricted historical body";
const WORKSPACE_API = `/api/workspaces/${SLUG}`;
const NOTE_API = `${WORKSPACE_API}/notes/history-note`;
const NOTE_ROUTE = `/${SLUG}/notes?note=history-note`;

class ServerSocket {
  static instances: ServerSocket[] = [];
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public url: string) { ServerSocket.instances.push(this); }
  send() {}
  open() { this.readyState = ServerSocket.OPEN; this.onopen?.(); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code } as CloseEvent); }
  removeMember(userId: string) {
    this.onmessage?.({ data: JSON.stringify({
      event: "activity.member.removed_member", event_id: `member-${userId}`, timestamp: "2026-10-23T20:00:00Z",
      payload: { entity_type: "member", entity_id: userId, action: "removed_member", board_id: null,
        changes: { affected_user_id: userId } },
    }) } as MessageEvent);
  }
}

const releases: Array<() => void> = [];
const clients: Array<ReturnType<typeof renderNavigationRouter>["client"]> = [];

function deferred() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { ready, release };
}

function mount() {
  const note = makeNote({ board_id: null, title: TITLE, content: BODY, created_by: VIEWER.id });
  const historical = revision(1, { snapshot: { ...revision(1).snapshot, content: `<p>${HISTORY_BODY}</p>` } });
  const workspace = { id: note.workspace_id, slug: SLUG, name: "Restricted workspace", description: "", role: "member", created_at: note.created_at };
  const state = {
    authorized: true, workspaceGate: null as ReturnType<typeof deferred> | null,
    workspaceRequests: 0, delayedWorkspaceResponses: 0, unexpected: [] as string[], writes: [] as string[],
  };
  server.use(http.all("/api/*", async ({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") {
      state.writes.push(`${request.method} ${path}`);
      return HttpResponse.json({ detail: "Unexpected mutation" }, { status: 400 });
    }
    if (path === WORKSPACE_API) {
      state.workspaceRequests++;
      const authorized = state.authorized;
      const gate = state.workspaceGate;
      state.workspaceGate = null;
      await gate?.ready;
      if (gate) state.delayedWorkspaceResponses++;
      return HttpResponse.json(authorized ? workspace : { detail: "Workspace unavailable" }, { status: authorized ? 200 : 403 });
    }
    if (path.startsWith(`${WORKSPACE_API}/`) && !state.authorized) {
      return HttpResponse.json({ detail: "Workspace unavailable" }, { status: 403 });
    }
    if (path === "/api/me") return HttpResponse.json(VIEWER);
    if (path === "/api/auth/modes") return HttpResponse.json({ companion_enabled: false, password_enabled: false, oidc_enabled: false, dev_mode: true });
    if (path === "/api/auth/setup-status") return HttpResponse.json({ needs_setup: false });
    if (path === "/api/workspaces") return HttpResponse.json(state.authorized ? [workspace] : []);
    if (path === NOTE_API) return HttpResponse.json(note);
    if (path === `${WORKSPACE_API}/notes`) {
      const { content, ...summary } = note;
      void content;
      return HttpResponse.json([{ ...summary, preview: "Restricted current preview" }], { headers: { "X-Total-Count": "1" } });
    }
    if (path === `${NOTE_API}/revisions`) {
      const { snapshot, ...summary } = historical;
      void snapshot;
      return HttpResponse.json({ items: [summary], next_before_revision: null, latest_recorded_revision: 1,
        capture_boundary: { first_revision: 1, capture_kind: "creation" } });
    }
    if (path === `${NOTE_API}/revisions/1`) return HttpResponse.json(historical);
    if (path === `${WORKSPACE_API}/members`) return HttpResponse.json([{ user_id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, role: "member" }]);
    if (path.endsWith("/unread-count")) return HttpResponse.json({ count: 0 });
    if (path.endsWith("/notifications") || path.endsWith("/approvals") || path.endsWith("/boards")) return HttpResponse.json([]);
    if (path.endsWith("/sessions")) return HttpResponse.json({ items: [], next_cursor: null });
    if (path.endsWith("/config/completion-context-impact")) return HttpResponse.json({ attempts: [] });
    state.unexpected.push(path);
    return HttpResponse.json({ detail: "Unspecified fixture endpoint" }, { status: 500 });
  }));
  const rendered = renderNavigationRouter([
    { path: "/:slug", element: <WebSocketProvider><WorkspaceLayout /></WebSocketProvider>, children: [
      { path: "notes", element: <WorkspaceNotesPage /> },
    ] },
    { path: "/", element: <h1>Workspace choice</h1> },
  ], { initialEntries: [NOTE_ROUTE] });
  clients.push(rendered.client);
  return { ...rendered, state };
}

async function openNote() {
  await screen.findByDisplayValue(TITLE);
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(BODY);
  await waitFor(() => expect(ServerSocket.instances).toHaveLength(1));
  const socket = ServerSocket.instances[0]!;
  act(() => socket.open());
  return socket;
}

async function openHistory() {
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  const dialog = await screen.findByRole("dialog", { name: /history/i });
  fireEvent.click(await within(dialog).findByRole("button", { name: /^Revision 1(?:\D|$)/i }));
  expect(await within(dialog).findByText(HISTORY_BODY)).toBeVisible();
}

async function dismissHistory() {
  if (screen.queryByRole("dialog", { name: /history/i })) {
    await userEvent.setup({ pointerEventsCheck: 0 }).keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /history/i })).not.toBeInTheDocument());
  }
}

async function expectWorkspaceHidden() {
  await waitFor(() => expect(screen.queryByLabelText("Note body")).not.toBeInTheDocument());
  expect(screen.queryByDisplayValue(TITLE)).not.toBeInTheDocument();
  expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue(BODY)).not.toBeInTheDocument();
  expect(screen.queryByText(HISTORY_BODY)).not.toBeInTheDocument();
  expect(screen.queryByText("Restricted current preview")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
}

beforeEach(() => {
  ServerSocket.instances = [];
  vi.stubGlobal("WebSocket", ServerSocket);
  stubReducedMotion(true);
});
afterEach(() => {
  cleanup();
  releases.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
  stubReducedMotion(false);
});

describe("WorkspaceLayout access revocation through the live provider", () => {
  it("removes the cached note list and editor when the viewer is removed, including after History dismissal", async () => {
    const { state, client } = mount();
    const socket = await openNote();
    await openHistory();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData(noteKeys.detail(SLUG, "history-note"))).toMatchObject({ content: BODY });
    expect(state.unexpected).toEqual([]);
    state.authorized = false;
    act(() => socket.removeMember(VIEWER.id));
    await waitFor(() => expect(screen.queryByText(HISTORY_BODY)).not.toBeInTheDocument());
    await dismissHistory();
    await expectWorkspaceHidden();
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  it.each([4001, 4002])("removes a cached dirty note on accepted-socket authority close %s without requiring History", async (code) => {
    const { state } = mount();
    const socket = await openNote();
    expect(state.unexpected).toEqual([]);
    fireEvent.change(screen.getByDisplayValue(TITLE), { target: { value: "Unpublished title" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "<p>Unpublished body</p>" } });
    state.authorized = false;
    act(() => socket.close(code));
    await expectWorkspaceHidden();
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  it.each(["unrelated member removal", "transient disconnect"] as const)("preserves the authorized dirty note across %s and History dismissal", async (signal) => {
    const { state, client } = mount();
    const socket = await openNote();
    fireEvent.change(screen.getByDisplayValue(TITLE), { target: { value: "Unpublished title" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "<p>Unpublished body</p>" } });
    await openHistory();
    act(() => signal === "unrelated member removal" ? socket.removeMember("other-member") : socket.close(1006));
    await dismissHistory();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(screen.getByDisplayValue("Unpublished title")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Unpublished body</p>");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  it("does not let a workspace response admitted before revocation restore its cached note", async () => {
    const { state, client } = mount();
    const socket = await openNote();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const gate = deferred();
    state.workspaceGate = gate;
    const before = state.workspaceRequests;
    act(() => { void client.refetchQueries({ queryKey: workspaceKeys.bySlug(SLUG), exact: true }); });
    await waitFor(() => expect(state.workspaceRequests).toBe(before + 1));
    expect(state.unexpected).toEqual([]);
    state.authorized = false;
    act(() => socket.close(4002));
    await act(async () => gate.release());
    await waitFor(() => expect(state.delayedWorkspaceResponses).toBe(1));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await expectWorkspaceHidden();
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
});


describe("WorkspaceLayout revocation recovery", () => {
  it("keeps same-tab Back/Forward denied until a fresh workspace read confirms restored membership", async () => {
    const { state, client, router } = mount();
    const socket = await openNote();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    state.authorized = false;
    act(() => socket.removeMember(VIEWER.id));
    await expectWorkspaceHidden();
    await act(async () => { await router.navigate("/"); });
    expect(screen.getByRole("heading", { name: "Workspace choice" })).toBeVisible();
    const deniedReads = state.workspaceRequests;
    await act(async () => { await router.navigate(-1); });
    await screen.findByTestId("workspace-not-found");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(state.workspaceRequests).toBeGreaterThan(deniedReads);
    await expectWorkspaceHidden();
    await act(async () => { await router.navigate(1); });
    expect(screen.getByRole("heading", { name: "Workspace choice" })).toBeVisible();
    state.authorized = true;
    const restoredReads = state.workspaceRequests;
    await act(async () => { await router.navigate(NOTE_ROUTE); });
    expect(await screen.findByDisplayValue(TITLE)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(BODY);
    expect(state.workspaceRequests).toBeGreaterThan(restoredReads);
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  it("purges revoked workspace query data while retaining another workspace's cached draft", async () => {
    const { state, client } = mount();
    const socket = await openNote();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const otherKey = noteKeys.detail("another-workspace", "other-note");
    const otherDraft = { title: "Other workspace draft", content: "Still authorized" };
    client.setQueryDefaults(otherKey, { gcTime: Infinity });
    client.setQueryData(otherKey, otherDraft);
    const privateKeys = [
      noteKeys.detail(SLUG, "history-note"),
      noteKeys.byWorkspace(SLUG),
      ["sessions", SLUG, "detail", "retained", "content-body", "body", "digest", 0],
      ["note-history", VIEWER.id, SLUG, "workspace", SLUG, "history-note", "revision", 1],
      ["resources", "tags", SLUG, "workspace"],
    ];
    for (const key of privateKeys.slice(2)) {
      client.setQueryDefaults(key, { gcTime: Infinity });
      client.setQueryData(key, { private: "retained content" });
    }
    state.authorized = false;
    act(() => socket.close(4002));
    await expectWorkspaceHidden();
    for (const key of privateKeys) expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(otherKey)).toEqual(otherDraft);
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
});


it("recovers a revoked open route only after reconnection and a fresh authorized workspace response", async () => {
  const { state, client } = mount();
  const socket = await openNote();
  await waitFor(() => expect(client.isFetching()).toBe(0));
  state.authorized = false;
  act(() => socket.close(4002));
  await expectWorkspaceHidden();
  const previousReads = state.workspaceRequests;
  state.authorized = true;
  await waitFor(() => expect(ServerSocket.instances).toHaveLength(2), { timeout: 3000 });
  act(() => ServerSocket.instances[1]!.open());
  expect(await screen.findByDisplayValue(TITLE)).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue(BODY);
  expect(state.workspaceRequests).toBeGreaterThan(previousReads);
  expect(state.writes).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

describe("WorkspaceLayout revocation focus", () => {
  afterEach(async () => {
    cleanup();
    await i18n.changeLanguage("en");
  });

  it.each(SUPPORTED_LANGUAGES)("moves focus from removed History to a meaningful localized %s denial or recovery destination", async (language) => {
    await i18n.changeLanguage(language);
    const { state, client } = mount();
    const socket = await openNote();
    const historyName = String(i18n.t("notes.history.action"));
    fireEvent.click(screen.getByRole("button", { name: historyName }));
    const dialog = await screen.findByRole("dialog", { name: historyName });
    const revisionName = String(i18n.t("notes.history.revision", { revision: 1 }));
    fireEvent.click(await within(dialog).findByRole("button", { name: (name) => name.startsWith(revisionName) }));
    expect(await within(dialog).findByText(HISTORY_BODY)).toBeVisible();
    const close = within(dialog).getByRole("button", { name: String(i18n.t("common.close")) });
    close.focus();
    expect(close).toHaveFocus();

    state.authorized = false;
    act(() => socket.close(4002));
    await expectWorkspaceHidden();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    const unavailable = await screen.findByTestId("workspace-not-found");
    const heading = within(unavailable).getByRole("heading", { name: String(i18n.t("workspace.notFound.title")) });
    const recovery = within(unavailable).getByRole("link", { name: String(i18n.t("workspace.notFound.backToList")) });
    const region = screen.queryByRole("region", { name: String(i18n.t("workspace.notFound.title")) });
    expect(heading).toBeVisible();
    expect(recovery).toBeVisible();
    await waitFor(() => expect([heading, recovery, region].filter(Boolean)).toContain(document.activeElement));
    expect(unavailable).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBeVisible();
    expect(document.activeElement).toHaveAccessibleName();
    expect(close).not.toBeInTheDocument();
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });

  it.each(["unrelated member removal", "transient disconnect"] as const)("preserves History focus and the authorized draft across %s", async (signal) => {
    const { state, client } = mount();
    const socket = await openNote();
    fireEvent.change(screen.getByDisplayValue(TITLE), { target: { value: "Unpublished title" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note body" }), { target: { value: "<p>Unpublished body</p>" } });
    const opener = screen.getByRole("button", { name: "History" });
    await openHistory();
    const close = within(screen.getByRole("dialog", { name: /history/i })).getByRole("button", { name: "Close" });
    close.focus();
    expect(close).toHaveFocus();

    act(() => signal === "unrelated member removal" ? socket.removeMember("other-member") : socket.close(1006));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(close).toHaveFocus();
    expect(screen.queryByTestId("workspace-not-found")).not.toBeInTheDocument();
    await dismissHistory();
    expect(opener).toHaveFocus();
    expect(screen.getByDisplayValue("Unpublished title")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Note body" })).toHaveValue("<p>Unpublished body</p>");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(state.writes).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
});
