// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReactNode } from "react";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { meKeys, sessionKeys } from "@/lib/query-keys";
import type { ConnectionStatus, WebSocketEvent } from "@/lib/websocket";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import { ME, SLUG, makeContent, makeSession } from "../../__tests__/fixtures";
import { useCardSessions, useNoteSessions } from "../use-linked-sessions";
import { useContentBodyPages, useContentImage } from "../use-session-contents";
import { useSessionRealtime } from "../use-session-realtime";
import { useSessionLinks } from "../use-sessions";

const TARGET_SLUG = "linked-target";
const SESSION_ID = "private-source-session";
const BOARD_ID = "target-board";
const CARD_ID = "target-card";
const NOTE_ID = "target-note";
const LINKS_PATH = `/api/workspaces/${SLUG}/sessions/${SESSION_ID}/links`;
const CARD_PATH = `/api/workspaces/${TARGET_SLUG}/boards/${BOARD_ID}/cards/${CARD_ID}/sessions`;
const NOTE_PATH = `/api/workspaces/${TARGET_SLUG}/notes/${NOTE_ID}/sessions`;
const BODY = makeContent({ id: "previously-opened-body", session_id: SESSION_ID, sha256: "body-digest" });
const IMAGE = makeContent({ id: "previously-opened-image", session_id: SESSION_ID, sha256: "image-digest", media_type: "image/png", render: "image" });
const clients: QueryClient[] = [];
const releasePendingIdentities: Array<() => void> = [];

afterEach(() => {
  releasePendingIdentities.splice(0).forEach((release) => release());
  clients.splice(0).forEach((client) => client.clear());
});

function eventConnection() {
  const listeners = new Map<string, Set<(event: WebSocketEvent) => void>>();
  const subscribe = (pattern: string, handler: (event: WebSocketEvent) => void) => {
    const handlers = listeners.get(pattern) ?? new Set();
    handlers.add(handler);
    listeners.set(pattern, handlers);
    return () => { handlers.delete(handler); };
  };
  return {
    subscribe,
    send(payload: WebSocketEvent["payload"]) {
      const handlers = listeners.get("agent_session.*");
      expect(handlers?.size).toBe(1);
      handlers!.forEach((handler) => handler({ event: "agent_session.updated", payload,
        timestamp: "2026-10-17T20:00:00Z", event_id: "synthetic-link-update" }));
    },
  };
}

function SourceEvidence() {
  const links = useSessionLinks(SLUG, SESSION_ID, true);
  useContentBodyPages(SLUG, SESSION_ID, BODY, [0]);
  useContentImage(SLUG, SESSION_ID, IMAGE, true);
  return <output aria-label="Source relationships">{links.data?.items.length}</output>;
}

function TargetEvidence() {
  const card = useCardSessions(TARGET_SLUG, BOARD_ID, CARD_ID, true);
  const note = useNoteSessions(TARGET_SLUG, NOTE_ID, true);
  return <>
    <output aria-label="Card sessions">{card.data?.items.length}</output>
    <output aria-label="Note sessions">{note.data?.items.length}</output>
  </>;
}

function Realtime({ slug, children }: { slug: string; children: ReactNode }) {
  useSessionRealtime(slug);
  return children;
}

function renderEvidence(slug: string, status: ConnectionStatus = "connected", userKnown: boolean | "pending" = true, existingClient?: QueryClient) {
  const client = existingClient ?? new QueryClient({ defaultOptions: { queries: {
    retry: false, gcTime: Infinity, staleTime: 30_000, refetchOnWindowFocus: false,
  } } });
  if (!existingClient) clients.push(client);
  if (userKnown !== "pending") {
    client.setQueryData(meKeys.me(), userKnown ? { id: ME, name: "Synthetic owner", email: "owner@example.test", avatar_url: null } : null);
  }
  // These are already-opened immutable bytes. A metadata signal must not ask
  // for them again, including after a socket outage while the browser is online.
  client.setQueryData(sessionKeys.contentBody(SLUG, SESSION_ID, BODY.id, BODY.sha256!, 0), {
    content_id: BODY.id, offset: 0, next_offset: null, total_bytes: 0, text: "",
  });
  client.setQueryData(sessionKeys.contentFile(SLUG, SESSION_ID, IMAGE.id, IMAGE.sha256!), new Blob());
  const connection = eventConnection();
  const view = (next: ConnectionStatus) => <WebSocketContext.Provider value={{ status: next, subscribe: connection.subscribe }}>
    <Realtime slug={slug}>{slug === SLUG ? <SourceEvidence /> : <TargetEvidence />}</Realtime>
  </WebSocketContext.Provider>;
  const rendered = renderWithProviders(view(status), { queryClient: client });
  return { ...rendered, client, connection, status: (next: ConnectionStatus) => rendered.rerender(view(next)) };
}

function serveEvidence(holdCurrentUser = false) {
  let releaseCurrentUser = () => {};
  const currentUserReady = holdCurrentUser ? new Promise<void>((resolve) => { releaseCurrentUser = resolve; }) : Promise.resolve();
  if (holdCurrentUser) releasePendingIdentities.push(releaseCurrentUser);
  const state = { linked: true, requests: [] as string[], releaseCurrentUser };
  const source = makeSession({ id: SESSION_ID });
  server.use(http.get("/api/*", async ({ request }) => {
    const path = new URL(request.url).pathname;
    state.requests.push(path);
    if (path === "/api/me") {
      await currentUserReady;
      return HttpResponse.json({ id: ME, name: "Synthetic owner", email: "owner@example.test", avatar_url: null });
    }
    if (path === LINKS_PATH) return HttpResponse.json({ items: state.linked ? [{
      entity_type: "card", entity_id: CARD_ID, workspace_id: "target-workspace", board_id: BOARD_ID,
      relation: "changed", provenance: "correlated", invocation_count: 1,
      first_seen_at: source.started_at, last_seen_at: source.last_event_at,
    }] : [] });
    if (path === CARD_PATH || path === NOTE_PATH) return HttpResponse.json({
      items: state.linked ? [{ session: source, relations: ["changed"], provenance: "correlated",
        first_seen_at: source.started_at, last_seen_at: source.last_event_at }] : [],
      summary: { session_count: state.linked ? 1 : 0 },
    });
    return HttpResponse.json({ detail: "Unexpected synthetic read" }, { status: 400 });
  }));
  return state;
}

async function emitBurst(connection: ReturnType<typeof eventConnection>, payload: WebSocketEvent["payload"]) {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) connection.send(payload);
    await new Promise((resolve) => setTimeout(resolve, 2050));
  });
}

async function resolveCurrentUser(state: ReturnType<typeof serveEvidence>, view: ReturnType<typeof renderEvidence>) {
  await act(async () => { state.releaseCurrentUser(); });
  await waitFor(() => expect(view.client.getQueryData(meKeys.me())).toMatchObject({ id: ME }));
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
}

function expectImmutableEvidenceUnchanged(client: QueryClient) {
  expect(client.getQueryState(sessionKeys.contentBody(SLUG, SESSION_ID, BODY.id, BODY.sha256!, 0))?.isInvalidated).toBe(false);
  expect(client.getQueryState(sessionKeys.contentFile(SLUG, SESSION_ID, IMAGE.id, IMAGE.sha256!))?.isInvalidated).toBe(false);
}

describe("Session evidence realtime recovery", () => {
  it("coalesces committed owner updates into durable relationship reads without rereading body or file bytes", async () => {
    const state = serveEvidence();
    const { client, connection } = renderEvidence(SLUG);
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    state.linked = false;

    await emitBurst(connection, { owner_id: ME, session_id: SESSION_ID });

    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("0"));
    expect(state.requests).toEqual([LINKS_PATH, LINKS_PATH]);
    expect(client.getQueryState(sessionKeys.contentBody(SLUG, SESSION_ID, BODY.id, BODY.sha256!, 0))?.isInvalidated).toBe(false);
    expect(client.getQueryState(sessionKeys.contentFile(SLUG, SESSION_ID, IMAGE.id, IMAGE.sha256!))?.isInvalidated).toBe(false);
  });

  it("refreshes linked card and note views from the minimal authorized target-workspace signal", async () => {
    const state = serveEvidence();
    const { connection } = renderEvidence(TARGET_SLUG);
    await waitFor(() => expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1"));
    state.linked = false;

    await emitBurst(connection, { owner_id: ME, workspace_id: "target-workspace", reason: "links" });

    await waitFor(() => expect(screen.getByLabelText("Card sessions")).toHaveTextContent("0"));
    await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("0"));
    expect([...state.requests].sort()).toEqual([CARD_PATH, CARD_PATH, NOTE_PATH, NOTE_PATH].sort());
  });

  it("does not refetch another owner's linked views when their identifier-only event reaches this workspace", async () => {
    const state = serveEvidence();
    const { connection } = renderEvidence(TARGET_SLUG);
    await waitFor(() => expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1"));
    state.linked = false;

    await emitBurst(connection, { owner_id: "another-owner", workspace_id: "target-workspace", reason: "links" });

    expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1");
    expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1");
    expect([...state.requests].sort()).toEqual([CARD_PATH, NOTE_PATH].sort());
  });

  it("does not duplicate the initial read when the socket first connects or reports an unchanged connected status", async () => {
    const state = serveEvidence();
    const view = renderEvidence(SLUG, "connecting");
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));

    view.status("connected");
    view.status("connected");

    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(state.requests).toEqual([LINKS_PATH]);
  });

  it("does not refresh from an owner event or reconnection while current-user identity is unavailable", async () => {
    const state = serveEvidence();
    const view = renderEvidence(SLUG, "connected", false);
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    state.linked = false;

    await emitBurst(view.connection, { owner_id: ME, session_id: SESSION_ID });
    view.status("reconnecting");
    view.status("connected");

    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1");
    expect(state.requests).toEqual([LINKS_PATH]);
  });

  it("recovers the missed change when owner identity resolves after reconnect", async () => {
    const state = serveEvidence();
    const view = renderEvidence(SLUG, "connected", false);
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    view.status("reconnecting");
    state.linked = false;
    view.status("connected");
    expect(state.requests).toEqual([LINKS_PATH]);

    await act(async () => {
      view.client.setQueryData(meKeys.me(), {
        id: ME, name: "Synthetic owner", email: "owner@example.test", avatar_url: null,
      });
    });

    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("0"));
    expect(state.requests).toEqual([LINKS_PATH, LINKS_PATH]);
    expect(view.client.getQueryState(sessionKeys.contentBody(SLUG, SESSION_ID, BODY.id, BODY.sha256!, 0))?.isInvalidated).toBe(false);
    expect(view.client.getQueryState(sessionKeys.contentFile(SLUG, SESSION_ID, IMAGE.id, IMAGE.sha256!))?.isInvalidated).toBe(false);
  });

  it("keeps the initial read when owner identity resolves after the first connection", async () => {
    const state = serveEvidence();
    const view = renderEvidence(SLUG, "connecting", false);
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    view.status("connected");

    await act(async () => {
      view.client.setQueryData(meKeys.me(), {
        id: ME, name: "Synthetic owner", email: "owner@example.test", avatar_url: null,
      });
    });

    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1");
    expect(state.requests).toEqual([LINKS_PATH]);
    expect(view.client.getQueryState(sessionKeys.contentBody(SLUG, SESSION_ID, BODY.id, BODY.sha256!, 0))?.isInvalidated).toBe(false);
    expect(view.client.getQueryState(sessionKeys.contentFile(SLUG, SESSION_ID, IMAGE.id, IMAGE.sha256!))?.isInvalidated).toBe(false);
  });

  it("drops a pending old-workspace event when its realtime owner unmounts during navigation", async () => {
    const state = serveEvidence();
    const source = renderEvidence(SLUG);
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    act(() => source.connection.send({ owner_id: ME, session_id: SESSION_ID }));
    source.unmount();
    const target = renderEvidence(TARGET_SLUG);
    await waitFor(() => expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });

    expect([...state.requests].sort()).toEqual([LINKS_PATH, CARD_PATH, NOTE_PATH].sort());
    expect(source.client.getQueryState(sessionKeys.links(SLUG, SESSION_ID))?.isInvalidated).toBe(false);
    expect(target.client.getQueryState(sessionKeys.onCard(TARGET_SLUG, BOARD_ID, CARD_ID))?.isInvalidated).toBe(false);
  });

  it.each([SLUG, TARGET_SLUG])("recovers a missed committed change after the %s socket reconnects while browser networking stays online", async (slug) => {
    const state = serveEvidence();
    const view = renderEvidence(slug);
    const label = slug === SLUG ? "Source relationships" : "Card sessions";
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveTextContent("1"));
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    expect(onlineManager.isOnline()).toBe(true);
    view.status("reconnecting");
    state.linked = false;
    view.status("connecting");
    view.status("connected");

    await waitFor(() => expect(screen.getByLabelText(label)).toHaveTextContent("0"));
    if (slug === TARGET_SLUG) expect(screen.getByLabelText("Note sessions")).toHaveTextContent("0");
    expect([...state.requests].sort()).toEqual(slug === SLUG
      ? [LINKS_PATH, LINKS_PATH]
      : [CARD_PATH, CARD_PATH, NOTE_PATH, NOTE_PATH].sort());
    expect(onlineManager.isOnline()).toBe(true);
    expect(view.client.getQueryState(sessionKeys.contentBody(SLUG, SESSION_ID, BODY.id, BODY.sha256!, 0))?.isInvalidated).toBe(false);
    expect(view.client.getQueryState(sessionKeys.contentFile(SLUG, SESSION_ID, IMAGE.id, IMAGE.sha256!))?.isInvalidated).toBe(false);
  });
});

describe("Session evidence before cold-start identity resolves", () => {
  it.each([SLUG, TARGET_SLUG])("recovers one matching burst on the first %s connection after the initial evidence read", async (slug) => {
    const state = serveEvidence(true);
    const view = renderEvidence(slug, "connecting", "pending");
    const label = slug === SLUG ? "Source relationships" : "Card sessions";
    const initialPaths = slug === SLUG ? [LINKS_PATH] : [CARD_PATH, NOTE_PATH];
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveTextContent("1"));
    if (slug === TARGET_SLUG) await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1"));
    view.status("connected");
    state.linked = false;

    await emitBurst(view.connection, { owner_id: ME, workspace_id: "synthetic-workspace", reason: "links" });

    expect(view.client.getQueryData(meKeys.me())).toBeUndefined();
    expect([...state.requests].sort()).toEqual(["/api/me", ...initialPaths].sort());
    expect(screen.getByLabelText(label)).toHaveTextContent("1");
    await resolveCurrentUser(state, view);

    await waitFor(() => expect(screen.getByLabelText(label)).toHaveTextContent("0"));
    if (slug === TARGET_SLUG) expect(screen.getByLabelText("Note sessions")).toHaveTextContent("0");
    // A second debounce window catches a deferred burst that refreshes twice.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });
    expect([...state.requests].sort()).toEqual(["/api/me", ...initialPaths, ...initialPaths].sort());
    expectImmutableEvidenceUnchanged(view.client);
  }, 10_000);

  it("keeps settled evidence after only foreign or malformed events arrive before identity", async () => {
    const state = serveEvidence(true);
    const view = renderEvidence(TARGET_SLUG, "connecting", "pending");
    await waitFor(() => expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1"));
    view.status("connected");
    state.linked = false;
    await act(async () => {
      view.connection.send({ owner_id: "another-owner", reason: "links" });
      view.connection.send({ reason: "links" });
      view.connection.send({ owner_id: 7, reason: "links" });
    });

    await resolveCurrentUser(state, view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });

    expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1");
    expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1");
    expect([...state.requests].sort()).toEqual(["/api/me", CARD_PATH, NOTE_PATH].sort());
    expect(view.client.getQueryState(sessionKeys.onCard(TARGET_SLUG, BOARD_ID, CARD_ID))?.isInvalidated).toBe(false);
    expect(view.client.getQueryState(sessionKeys.onNote(TARGET_SLUG, NOTE_ID))?.isInvalidated).toBe(false);
    expectImmutableEvidenceUnchanged(view.client);
  });

  it.each([
    { name: "own then foreign", owners: [ME, "another-owner"] },
    { name: "foreign then own", owners: ["another-owner", ME] },
  ])("retains the matching deferred signal for $name events", async ({ owners }) => {
    const state = serveEvidence(true);
    const view = renderEvidence(SLUG, "connected", "pending");
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    state.linked = false;
    await act(async () => {
      for (const ownerId of owners) view.connection.send({ owner_id: ownerId, reason: "links" });
    });
    expect(view.client.getQueryData(meKeys.me())).toBeUndefined();
    expect([...state.requests].sort()).toEqual(["/api/me", LINKS_PATH].sort());

    await resolveCurrentUser(state, view);

    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("0"));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });
    expect([...state.requests].sort()).toEqual(["/api/me", LINKS_PATH, LINKS_PATH].sort());
    expectImmutableEvidenceUnchanged(view.client);
  });

  it("keeps a first connection quiet when identity resolves without any session event", async () => {
    const state = serveEvidence(true);
    const view = renderEvidence(SLUG, "connecting", "pending");
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    view.status("connected");
    state.linked = false;

    await resolveCurrentUser(state, view);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });

    expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1");
    expect([...state.requests].sort()).toEqual(["/api/me", LINKS_PATH].sort());
    expect(view.client.getQueryState(sessionKeys.links(SLUG, SESSION_ID))?.isInvalidated).toBe(false);
    expectImmutableEvidenceUnchanged(view.client);
  });

  it("discards an unidentified owner's event when its workspace owner unmounts", async () => {
    const state = serveEvidence(true);
    const source = renderEvidence(SLUG, "connected", "pending");
    await waitFor(() => expect(screen.getByLabelText("Source relationships")).toHaveTextContent("1"));
    act(() => source.connection.send({ owner_id: ME, reason: "links" }));
    source.unmount();
    const target = renderEvidence(TARGET_SLUG, "connected", "pending", source.client);
    await waitFor(() => expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1"));
    await waitFor(() => expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1"));
    state.linked = false;

    await resolveCurrentUser(state, target);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2050)); });

    expect(screen.getByLabelText("Card sessions")).toHaveTextContent("1");
    expect(screen.getByLabelText("Note sessions")).toHaveTextContent("1");
    expect([...state.requests].sort()).toEqual(["/api/me", LINKS_PATH, CARD_PATH, NOTE_PATH].sort());
    expect(target.client.getQueryState(sessionKeys.links(SLUG, SESSION_ID))?.isInvalidated).toBe(false);
    expect(target.client.getQueryState(sessionKeys.onCard(TARGET_SLUG, BOARD_ID, CARD_ID))?.isInvalidated).toBe(false);
    expect(target.client.getQueryState(sessionKeys.onNote(TARGET_SLUG, NOTE_ID))?.isInvalidated).toBe(false);
    expectImmutableEvidenceUnchanged(target.client);
  });
});
