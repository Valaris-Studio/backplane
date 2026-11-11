// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type { QueryClient } from "@tanstack/react-query";
import type { createBrowserRouter } from "react-router-dom";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, stubReducedMotion, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { ApiError } from "@/lib/api-error";
import { meKeys, noteKeys } from "@/lib/query-keys";
import { makeContent, makeSession } from "@/features/sessions/__tests__/fixtures";
import type { HandoffDraftController, HandoffForm } from "@/features/sessions/hooks/use-handoff-drafts";
import type { ExcerptNoteDraft } from "@/features/sessions/utils/excerpt-note";
import type { useReturnNavigation } from "@/providers/ReturnNavigationProvider";
import type { Note } from "@/types/note";

const owned = vi.hoisted(() => ({
  roots: [] as Root[], clients: [] as QueryClient[],
  routers: [] as ReturnType<typeof createBrowserRouter>[],
  handoff: null as HandoffDraftController | null,
  navigation: null as ReturnType<typeof useReturnNavigation>,
  actualApp: false, completed: 0,
}));
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  return { ...original, createRoot: (...args: Parameters<typeof original.createRoot>) => {
    const root = original.createRoot(...args); owned.roots.push(root); return root;
  } };
});
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const original = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...original, QueryClient: class extends original.QueryClient {
    constructor(...args: ConstructorParameters<typeof original.QueryClient>) {
      super(...args); owned.clients.push(this);
    }
  } };
});
vi.mock("react-router-dom", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router-dom")>();
  return { ...original, createBrowserRouter: (...args: Parameters<typeof original.createBrowserRouter>) => {
    const router = original.createBrowserRouter(...args); owned.routers.push(router); return router;
  } };
});
// The probe captures real provider actions; the actual publication dialog and
// mutation settle across a real main-owned identity transition. The note case
// also renders the actual App/AppShell/NoteEditor without component substitutes.
async function applicationFixture(importOriginal: () => Promise<typeof import("@/App")>) {
  const original = await importOriginal();
  const { useEffect } = await import("react");
  const { useCurrentUser } = await import("@/features/notifications/api/use-current-user");
  const { useHandoffDraft } = await import("@/features/sessions/hooks/use-handoff-drafts");
  const { useReturnNavigation: useNavigation } = await import("@/providers/ReturnNavigationProvider");
  const { ExcerptNoteDialog } = await import("@/features/sessions/components/ExcerptNoteDialog");
  function IdentityProbe() {
    const me = useCurrentUser();
    const handoff = useHandoffDraft("lifecycle", "source-session");
    const navigation = useNavigation();
    useEffect(() => { owned.handoff = handoff; owned.navigation = navigation; });
    return <>
      <output aria-label="Identity request status">{me.status}</output>
      <a href="/lifecycle/notes" id="lifecycle-origin-link">Lifecycle origin</a>
      {handoff.state.draft && handoff.state.form ? <ExcerptNoteDialog
        draft={handoff.state.draft} handoff={handoff} stale={false}
        onDiscard={handoff.clear} onComplete={() => { owned.completed += 1; handoff.setDraft(null); }}
      /> : null}
    </>;
  }
  return { ...original, App: () => <>{owned.actualApp ? <original.App /> : null}<IdentityProbe /></> };
}
vi.mock("@/providers/WebSocketProvider", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/providers/WebSocketProvider")>(),
  WebSocketProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/shared/InitialCatalog", () => ({ InitialCatalog: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/ThemedToaster", () => ({ ThemedToaster: () => null }));
// Settle the error state once, without changing cached-data/error semantics.
vi.mock("@/lib/should-retry", () => ({ shouldRetry: () => false }));

const ownerA = { id: "lifecycle-owner-a", name: "Owner A", email: "a@example.test", avatar_url: null };
const ownerB = { id: "lifecycle-owner-b", name: "Owner B", email: "b@example.test", avatar_url: null };
const workspace = { id: "lifecycle-workspace", slug: "lifecycle", name: "Lifecycle workspace", created_by: ownerA.id, created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z" };
const board = { id: "lifecycle-board", name: "Lifecycle board", slug: "board", workspace_id: workspace.id, is_frozen: false, columns: [{ id: "todo", name: "To do", cards: [] }] };
const note: Note = {
  id: "lifecycle-note", workspace_id: workspace.id, board_id: null, card_id: null,
  title: "Persisted independently authorized note", content: "<p>Authorized note body.</p>", pinned: false,
  kind: "user_note", failure_class: null, findings: null, source_execution_id: null,
  created_by: ownerA.id, created_at: workspace.created_at, updated_at: workspace.updated_at,
};
const notePath = "/lifecycle/notes?note=lifecycle-note";
const privateText = "Owner A retained private handoff";
const retryId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const item = makeContent({ id: "source-content", session_id: "source-session", preview: null });
const draft: ExcerptNoteDraft = {
  fingerprint: "lifecycle-source-fingerprint",
  session: makeSession({ id: "source-session", workspace_id: workspace.id, owner_id: ownerA.id }),
  bodies: [{ item, text: "" }],
  document: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: privateText }] }] }),
};
const form: HandoffForm = {
  open: true, slug: workspace.slug, boardId: board.id, cardId: "", title: "Reviewed handoff", content: draft.document,
  request: { slug: workspace.slug, boardId: board.id, payload: {
    title: "Reviewed handoff", content: draft.document, card_id: null, pinned: false, client_request_id: retryId,
    excerpt_source: { workspace_id: workspace.id, session_id: "source-session", items: [{ content_id: item.id, sha256: item.sha256! }] },
  } },
  reviewedDestination: { workspace, board }, hadUnknownOutcome: true, hasSentRequest: true,
  pending: false, error: new ApiError("Unknown earlier outcome", 0),
};
const releases: (() => void)[] = [];

function holdResponse() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => { release = resolve; });
  releases.push(release);
  return { ready, release };
}

function serve(holdIdentity = false) {
  let releaseIdentity!: () => void;
  const identity = new Promise<void>((resolve) => { releaseIdentity = resolve; });
  releases.push(releaseIdentity);
  if (!holdIdentity) releaseIdentity();
  let releasePublication!: (response: Response) => void;
  const publication = new Promise<Response>((resolve) => { releasePublication = resolve; });
  releases.push(() => releasePublication(HttpResponse.error()));
  const traffic = {
    status: 200, owner: ownerA, identityReturned: 0, reads: [] as string[],
    workspaceStatus: 200, workspaceGate: null as ReturnType<typeof holdResponse> | null,
    workspaceRequests: [] as { owner: string; status: number }[],
    noteGate: null as ReturnType<typeof holdResponse> | null, noteRequests: 0, noteResponses: 0,
    writes: [] as { route: string; body: unknown }[], unexpected: [] as string[],
    releaseIdentity, releasePublication,
  };
  server.use(http.all("/api/*", async ({ request }) => {
    const path = new URL(request.url).pathname;
    const route = `${request.method} ${path}`;
    if (request.method !== "GET") {
      traffic.writes.push({ route, body: await request.json() });
      if (route === "POST /api/workspaces/lifecycle/boards/lifecycle-board/notes/from-excerpt") return publication;
    } else {
      traffic.reads.push(path);
      if (path === "/api/me") {
        await identity;
        traffic.identityReturned += 1;
        return traffic.status === 200 ? HttpResponse.json(traffic.owner)
          : HttpResponse.json({ detail: "Identity unavailable" }, { status: traffic.status });
      }
      if (path === "/api/workspaces/lifecycle") {
        const status = traffic.workspaceStatus;
        traffic.workspaceRequests.push({ owner: traffic.owner.id, status });
        await traffic.workspaceGate?.ready;
        return HttpResponse.json(status === 200 ? workspace : { detail: "Workspace unavailable" }, { status });
      }
      if (path === "/api/workspaces/lifecycle/notes/lifecycle-note") {
        const status = traffic.workspaceStatus;
        const gate = traffic.noteGate;
        traffic.noteGate = null;
        traffic.noteRequests += 1;
        await gate?.ready;
        traffic.noteResponses += 1;
        return HttpResponse.json(status === 200 ? note : { detail: "Note unavailable" }, { status });
      }
      if (path.startsWith("/api/workspaces/lifecycle/") && traffic.workspaceStatus !== 200) {
        return HttpResponse.json({ detail: "Workspace unavailable" }, { status: traffic.workspaceStatus });
      }
      const responses: Record<string, unknown> = {
        "/api/auth/modes": { oidc_enabled: false, password_enabled: false, dev_mode: true, companion_enabled: false, rich_capture_enabled: false },
        "/api/auth/setup-status": { needs_setup: false },
        "/api/workspaces": traffic.workspaceStatus === 200 ? [workspace] : [],
        "/api/workspaces/lifecycle/members": [{ user_id: ownerA.id, role: "owner", name: ownerA.name, email: ownerA.email }],
        "/api/workspaces/lifecycle/boards": [board], "/api/workspaces/lifecycle/boards/lifecycle-board": board,
        "/api/workspaces/lifecycle/agents": [],
        "/api/workspaces/lifecycle/notes": [{ ...Object.fromEntries(Object.entries(note).filter(([key]) => key !== "content")), preview: "Authorized note body." }],
        "/api/workspaces/lifecycle/config/completion-context-impact": { attempts: [] },
        "/api/notifications/unread-count": { count: 0 }, "/api/notifications": [],
        "/api/workspaces/lifecycle/approvals": [],
      };
      if (responses[path] !== undefined) return HttpResponse.json(responses[path], { headers: { "X-Total-Count": "1" } });
    }
    traffic.unexpected.push(route);
    return HttpResponse.json({ detail: "Unexpected identity lifecycle request" }, { status: 400 });
  }));
  return traffic;
}

async function mount(actualApp = false) {
  owned.actualApp = actualApp;
  const container = document.createElement("div"); container.id = "root"; document.body.append(container);
  window.history.replaceState({ idx: 0, key: "lifecycle-entry", usr: null }, "", actualApp ? notePath : "/lifecycle/sessions/source-session");
  await act(async () => { await import("../main"); });
  await waitFor(() => expect(owned.handoff).not.toBeNull());
  return owned.clients[0]!;
}

async function refreshIdentity(client: QueryClient) {
  await act(async () => { await client.refetchQueries({ queryKey: meKeys.me(), exact: true }); });
}

function expectEmptyHandoff() {
  expect(owned.handoff!.state.draft).toBeNull();
  expect(owned.handoff!.state.form).toBeNull();
  expect(owned.handoff!.state.selected.size).toBe(0);
}

async function expectPreviousNoteHidden() {
  await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).not.toBeInTheDocument());
  expect(screen.queryByDisplayValue(note.title)).not.toBeInTheDocument();
  expect(screen.queryByText(note.title)).not.toBeInTheDocument();
  expect(screen.queryAllByText("Authorized note body.")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  expect(screen.queryByTestId("unsaved-changes-prompt")).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.resetModules(); localStorage.clear(); sessionStorage.clear(); stubReducedMotion(true);
  // Fresh main modules must share context instances with this factory's hooks.
  vi.doMock("@/App", applicationFixture);
  owned.actualApp = false; owned.completed = 0; owned.handoff = null; owned.navigation = null;
});
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await act(async () => { owned.roots.splice(0).forEach((root) => root.unmount()); });
  owned.routers.splice(0).forEach((router) => router.dispose());
  owned.clients.splice(0).forEach((client) => client.clear());
  document.getElementById("root")?.remove(); stubReducedMotion(false);
});

describe("main-owned identity lifecycle", () => {
  it("hides A's fetched note before B's held workspace authorization and rejects a late A response", async () => {
    const traffic = serve();
    const client = await mount(true);
    await screen.findByDisplayValue(note.title);
    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toHaveTextContent("Authorized note body."));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData(meKeys.me())).toEqual(ownerA);
    expect(traffic.workspaceRequests).toEqual([{ owner: ownerA.id, status: 200 }]);

    const lateNote = holdResponse();
    traffic.noteGate = lateNote;
    const noteRequests = traffic.noteRequests;
    const noteResponses = traffic.noteResponses;
    act(() => { void client.refetchQueries({ queryKey: noteKeys.detail(workspace.slug, note.id), exact: true }); });
    await waitFor(() => expect(traffic.noteRequests).toBe(noteRequests + 1));
    expect(traffic.noteResponses).toBe(noteResponses);

    const nextAuthority = holdResponse();
    traffic.workspaceGate = nextAuthority;
    traffic.workspaceStatus = 403;
    traffic.owner = ownerB;
    await refreshIdentity(client);
    expect(client.getQueryData(meKeys.me())).toEqual(ownerB);
    await expectPreviousNoteHidden();
    await waitFor(() => expect(traffic.workspaceRequests).toContainEqual({ owner: ownerB.id, status: 403 }));

    await act(async () => { lateNote.release(); });
    await waitFor(() => expect(traffic.noteResponses).toBe(noteResponses + 1));
    await expectPreviousNoteHidden();
    await act(async () => { nextAuthority.release(); });
    await screen.findByTestId("workspace-not-found");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await expectPreviousNoteHidden();
    expect(traffic.writes).toEqual([]);
    expect(traffic.unexpected).toEqual([]);
  });

  it.each([401, 403])("hides the previously authenticated note after /me returns %s before workspace reauthorization", async (status) => {
    const traffic = serve();
    const client = await mount(true);
    await screen.findByDisplayValue(note.title);
    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toHaveTextContent("Authorized note body."));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData(meKeys.me())).toEqual(ownerA);
    const authority = holdResponse();
    traffic.workspaceGate = authority;
    traffic.workspaceStatus = 403;
    traffic.status = status;
    await refreshIdentity(client);
    expect(client.getQueryState(meKeys.me())?.status).toBe("error");
    await expectPreviousNoteHidden();
    await act(async () => { authority.release(); });
    await screen.findByTestId("workspace-not-found");
    await waitFor(() => expect(client.isFetching()).toBe(0));
    await expectPreviousNoteHidden();
    expect(traffic.writes).toEqual([]);
    expect(traffic.unexpected).toEqual([]);
  });

  it.each([200, 503])("preserves the authorized dirty note and focus after same-principal /me status %s", async (status) => {
    const traffic = serve();
    const client = await mount(true);
    const title = await screen.findByDisplayValue(note.title);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    fireEvent.change(title, { target: { value: "Owner A unsaved title" } });
    title.focus();
    expect(title).toHaveFocus();
    traffic.status = status;
    await refreshIdentity(client);
    expect(client.getQueryState(meKeys.me())?.status).toBe(status === 200 ? "success" : "error");
    expect(client.getQueryData(meKeys.me())).toEqual(ownerA);
    expect(screen.getByDisplayValue("Owner A unsaved title")).toBe(title);
    expect(title).toHaveFocus();
    expect(document.querySelector('[contenteditable="true"]')).toHaveTextContent("Authorized note body.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByTestId("workspace-not-found")).not.toBeInTheDocument();
    expect(traffic.writes).toEqual([]);
    expect(traffic.unexpected).toEqual([]);
  });

  it.each(["success", "unknown"] as const)("isolates owner B after A → denial → B when A's pending publication settles with %s", async (outcome) => {
    const traffic = serve();
    const client = await mount();
    await waitFor(() => expect(client.getQueryData(meKeys.me())).toEqual(ownerA));
    act(() => {
      expect(owned.handoff!.select(new Map([[item.id, item]]))).toBe(true);
      expect(owned.handoff!.setDraft(draft)).toBe(true);
      expect(owned.handoff!.setForm(draft, form)).toBe(true);
      owned.navigation!.writeView("reader", { selected: item.id, query: "Owner A private query" });
    });
    const prior = owned.handoff!;
    const oldNavigation = owned.navigation!;
    const reference = oldNavigation.capture(document.getElementById("lifecycle-origin-link")!);
    expect(reference).not.toBeNull();
    expect(prior.state.form?.request).toEqual(form.request);
    expect(traffic.writes).toEqual([]);

    traffic.status = 503;
    await refreshIdentity(client);
    expect(client.getQueryState(meKeys.me())?.status).toBe("error");
    expect(owned.handoff!.state.draft).toBe(draft);
    expect(owned.handoff!.state.form?.request).toBe(form.request);
    expect(owned.handoff!.state.selected.has(item.id)).toBe(true);
    expect(owned.navigation!.resolve(reference)).not.toBeNull();
    traffic.status = 200;
    await refreshIdentity(client);
    expect(owned.handoff!.state.draft).toBe(draft);
    expect(owned.handoff!.state.form?.request).toBe(form.request);
    expect(traffic.writes).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(traffic.writes).toHaveLength(1));
    expect(traffic.writes[0]!.body).toEqual(form.request!.payload);
    expect(owned.handoff!.state.form?.pending).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Hide for now" }));
    await act(async () => { await owned.routers[0]!.navigate("/lifecycle/notes"); });
    expect(location.pathname).toBe("/lifecycle/notes");
    expect(oldNavigation.resolve(reference)).not.toBeNull();
    traffic.status = 403;
    await refreshIdentity(client);
    expectEmptyHandoff();
    expect(owned.navigation!.resolve(reference)).toBeNull();
    expect(owned.navigation!.readView("reader")).toBeUndefined();
    expect(screen.queryByRole("dialog", { name: "Share as note" })).not.toBeInTheDocument();
    act(() => {
      expect(prior.select(new Map([[item.id, item]]))).toBe(false);
      expect(prior.setDraft(draft)).toBe(false);
      expect(prior.setForm(draft, form)).toBe(false);
      expect(prior.isCurrent(draft)).toBe(false);
      oldNavigation.writeView("reader", { query: "stale owner write" });
    });
    expectEmptyHandoff();
    const warning = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(warning);
    expect(warning.defaultPrevented).toBe(false);

    traffic.owner = ownerB; traffic.status = 200;
    await refreshIdentity(client);
    expect(client.getQueryData(meKeys.me())).toEqual(ownerB);
    expectEmptyHandoff();
    expect(owned.navigation!.resolve(reference)).toBeNull();
    const nextItem = makeContent({ id: "owner-b-content", session_id: "source-session", preview: null });
    const nextDraft = { ...draft, fingerprint: "owner-b-fingerprint", session: { ...draft.session, owner_id: ownerB.id }, bodies: [{ item: nextItem, text: "" }], document: "Owner B new private draft" };
    act(() => {
      expect(owned.handoff!.select(new Map([[nextItem.id, nextItem]]))).toBe(true);
      expect(owned.handoff!.setDraft(nextDraft)).toBe(true);
      owned.navigation!.writeView("reader", { selected: nextItem.id });
      expect(prior.setDraft(draft)).toBe(false);
      expect(prior.setForm(draft, form)).toBe(false);
    });
    await act(async () => { traffic.releasePublication(outcome === "success"
      ? HttpResponse.json({ ...note, id: "published-note", board_id: board.id }) : HttpResponse.error()); });
    await waitFor(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
    expect(owned.handoff!.state.draft).toBe(nextDraft);
    expect(owned.handoff!.state.form).toBeNull();
    expect([...owned.handoff!.state.selected.keys()]).toEqual([nextItem.id]);
    expect(owned.navigation!.readView("reader")).toEqual({ selected: nextItem.id });
    expect(prior.isCurrent(draft)).toBe(false);
    expect(prior.getForm(draft)).toBeNull();
    expect(owned.completed).toBe(0);
    expect(traffic.writes).toEqual([{ route: "POST /api/workspaces/lifecycle/boards/lifecycle-board/notes/from-excerpt", body: form.request!.payload }]);
    expect(traffic.unexpected).toEqual([]);
    expect(JSON.stringify({ href: location.href, state: history.state, local: { ...localStorage }, session: { ...sessionStorage } })).not.toMatch(/Owner A|source-content|aaaaaaaa-aaaa/);
  });

  it("keeps null-identity handoff and return memory unavailable when first /me denies an independently authorized note editor", async () => {
    const traffic = serve(true);
    const client = await mount(true);
    const title = await screen.findByDisplayValue(note.title);
    await waitFor(() => expect(document.querySelector('[contenteditable="true"]')).toHaveTextContent("Authorized note body."));
    expect(client.getQueryData(meKeys.me())).toBeUndefined();
    expect(traffic.identityReturned).toBe(0);
    expect(traffic.reads).toContain("/api/workspaces/lifecycle/notes/lifecycle-note");
    fireEvent.change(title, { target: { value: "Edited while first identity is pending" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    const before = { href: location.href, state: structuredClone(history.state) };
    act(() => {
      expect(owned.handoff!.setDraft(draft)).toBe(false);
      expect(owned.handoff!.select(new Map([[item.id, item]]))).toBe(false);
      owned.navigation!.writeView("reader", { query: "unowned private query" });
    });
    expect(owned.navigation!.readView("reader")).toBeUndefined();
    expect(owned.navigation!.capture(document.getElementById("lifecycle-origin-link")!)).toBeNull();

    traffic.status = 403;
    await act(async () => { traffic.releaseIdentity(); });
    await waitFor(() => expect(client.getQueryState(meKeys.me())?.status).toBe("error"));
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(traffic.identityReturned).toBe(1);
    expect(client.getQueryData(meKeys.me())).toBeUndefined();
    expectEmptyHandoff();
    act(() => {
      expect(owned.handoff!.setDraft(draft)).toBe(false);
      expect(owned.handoff!.setForm(draft, form)).toBe(false);
      expect(owned.handoff!.select(new Map([[item.id, item]]))).toBe(false);
      owned.navigation!.writeView("reader", { query: "denied private query" });
    });
    expect(owned.navigation!.readView("reader")).toBeUndefined();
    expect(owned.navigation!.capture(document.getElementById("lifecycle-origin-link")!)).toBeNull();
    expect(traffic.writes).toEqual([]);
    expect(traffic.unexpected).toEqual([]);
    expect({ href: location.href, state: history.state }).toEqual(before);
    // Characterization, not a global-authorization rule: /me denial does not
    // revoke the independently successful note response. A note access-loss
    // response is a different seam. Record this state without mandating purge.
    process.stdout.write("Initial identity denial note characterization " + JSON.stringify({
      editedTitlePresent: screen.queryByDisplayValue("Edited while first identity is pending") !== null,
      saveEnabled: !(screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
      retainedDraft: owned.handoff!.state.draft !== null,
      retainedSelectionCount: owned.handoff!.state.selected.size,
      returnSnapshotAvailable: owned.navigation!.readView("reader") !== undefined,
      implicitWriteCount: traffic.writes.length,
    }) + "\n");
  });
});
