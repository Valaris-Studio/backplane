// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { Route, Routes } from "react-router-dom";
import { act, renderWithProviders, screen, userEvent, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { api } from "@/lib/api";
import { sessionKeys } from "@/lib/query-keys";
import { SLUG, callPage, contentPage, makeCall, makeSession, stubAuthModes } from "../../__tests__/fixtures";
import { SessionDetailPage } from "../SessionDetailPage";

const SESSION = "session-private";
const SIBLING = "session-unrelated";
const PATH = `/api/workspaces/${SLUG}/sessions/${SESSION}`;
const PRIVATE_TITLE = "Private investigation title";
const PRIVATE_ARGS = "unpublished deployment credential investigation";
const PRIVATE_CHILD = "Private subagent investigation";
const privateCall = makeCall({ key: "call:private", name: "Inspect evidence", args_preview: PRIVATE_ARGS });
const session = makeSession({ id: SESSION, title: PRIVATE_TITLE, capture_levels: ["rich"] });
const clients: QueryClient[] = [];

function retainedClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } } });
  clients.push(client);
  return client;
}

beforeEach(() => {
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({ ...matchMedia(query), matches: query === "(min-width: 1280px)" }));
});

afterEach(() => {
  vi.restoreAllMocks(); clients.splice(0).forEach((client) => client.clear()); });

function serveSession() {
  const response = { status: 200 };
  stubAuthModes(true);
  server.use(
    http.get(PATH, () => response.status === 200 ? HttpResponse.json(session) : HttpResponse.json({ detail: "Unavailable" }, { status: response.status })),
    http.get(`${PATH}/calls`, () => HttpResponse.json(callPage([privateCall]))),
    http.get(`${PATH}/calls/:key`, () => HttpResponse.json({ key: privateCall.key, events: [] })),
    http.get(`${PATH}/usage`, () => HttpResponse.json({ price_table_version: "test", items: [] })),
    http.get(`${PATH}/rhythm`, () => HttpResponse.json({ start: session.started_at, end: session.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
    http.get(`${PATH}/links`, () => HttpResponse.json({ items: [] })),
    http.get(`${PATH}/contents`, () => HttpResponse.json(contentPage([]))),
    http.get(`${PATH}/children`, () => HttpResponse.json({ items: [makeSession({ id: "private-child", title: PRIVATE_CHILD, parent_session_id: SESSION })] })),
    http.get(`/api/workspaces/${SLUG}/boards`, () => HttpResponse.json([])),
    http.get("/api/workspaces", () => HttpResponse.json([{ id: "ws-1", slug: SLUG, name: "Acme" }])),
  );
  return response;
}

function renderSession(client: QueryClient, sessionId = SESSION) {
  return renderWithProviders(
    <Routes><Route path="/:slug/sessions/:sessionId" element={<SessionDetailPage />} /></Routes>,
    { queryClient: client, routerProps: { initialEntries: [`/${SLUG}/sessions/${sessionId}`] } },
  );
}

function descendants(client: QueryClient) {
  const root = sessionKeys.detail(SLUG, SESSION);
  return client.getQueryCache().findAll({ queryKey: root, predicate: (query) => query.queryKey.length > root.length });
}

async function deny(client: QueryClient, response: { status: number }, status = 403) {
  response.status = status;
  await act(async () => { await client.refetchQueries({ queryKey: sessionKeys.detail(SLUG, SESSION), exact: true }); });
  await waitFor(() => expect(screen.queryByRole("heading", { name: PRIVATE_TITLE })).not.toBeInTheDocument());
}

describe("Session authority loss clears the private observation surface", () => {
  it("clears a denied parent's retained evidence while its authorized child is open", async () => {
    const response = serveSession();
    const client = retainedClient();
    const parentView = renderSession(client);
    await screen.findByText(PRIVATE_ARGS);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(descendants(client).length).toBeGreaterThan(0);
    parentView.unmount();

    const child = makeSession({ id: "authorized-child", parent_session_id: SESSION, title: "Authorized child session" });
    const childPath = `/api/workspaces/${SLUG}/sessions/${child.id}`;
    server.use(
      http.get(childPath, () => HttpResponse.json(child)),
      http.get(`${childPath}/calls`, () => HttpResponse.json(callPage([makeCall({ args_preview: "Authorized child evidence" })]))),
      http.get(`${childPath}/usage`, () => HttpResponse.json({ price_table_version: "test", items: [] })),
      http.get(`${childPath}/rhythm`, () => HttpResponse.json({ start: child.started_at, end: child.last_event_at, live: false, bucket_seconds: 60, buckets: [], idle_spans: [], children: [], capture_gaps: 0 })),
      http.get(`${childPath}/links`, () => HttpResponse.json({ items: [] })),
      http.get(`${childPath}/contents`, () => HttpResponse.json(contentPage([]))),
      http.get(`${childPath}/children`, () => HttpResponse.json({ items: [] })),
    );
    response.status = 403;
    renderSession(client, child.id);

    await screen.findByRole("heading", { name: child.title! });
    await screen.findByText("Authorized child evidence");
    await waitFor(() => expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull());
    await waitFor(() => expect(descendants(client).map((query) => query.queryKey)).toEqual([]));
    expect(client.getQueryData(sessionKeys.detail(SLUG, child.id))).toEqual(child);
    expect(client.getQueryData(sessionKeys.calls(SLUG, child.id, "all"))).toBeDefined();
    expect(screen.queryByText(PRIVATE_ARGS)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: child.title! })).toBeInTheDocument();
  });

  it.each([401, 403, 404])("removes every retained detail descendant on %s while retaining the denial marker and unrelated session", async (status) => {
    const response = serveSession();
    const client = retainedClient();
    const unrelated = makeSession({ id: SIBLING, title: "Another authorized session" });
    client.setQueryData(sessionKeys.detail(SLUG, SIBLING), unrelated);
    client.setQueryData(sessionKeys.calls(SLUG, SIBLING, "all"), { pages: [callPage([makeCall({ args_preview: "Other session data" })])], pageParams: [null] });
    renderSession(client);
    await screen.findByRole("heading", { name: PRIVATE_TITLE });
    await screen.findByText(PRIVATE_ARGS);
    await screen.findByText(PRIVATE_CHILD);
    await waitFor(() => expect(client.isFetching()).toBe(0));

    // These inactive pages must leave with the visible surface; default gcTime=0 would hide the regression.
    client.setQueryData(sessionKeys.calls(SLUG, SESSION, "work"), { pages: [callPage([privateCall])], pageParams: [null] });
    client.setQueryData(sessionKeys.call(SLUG, SESSION, privateCall.key), { key: privateCall.key, events: [{ data: { output: "private call output" } }] });
    client.setQueryData(sessionKeys.contents(SLUG, SESSION, { kind: "tool" }), { pages: [contentPage([])], pageParams: [null] });
    client.setQueryData(sessionKeys.contentBody(SLUG, SESSION, "body-private", "sha-private", 0), { text: "private captured body" });
    client.setQueryData(sessionKeys.contentFile(SLUG, SESSION, "file-private", "sha-file"), "private captured file");
    expect(new Set(descendants(client).map((query) => query.queryKey[4]))).toEqual(new Set(["calls", "call", "usage", "links", "children", "rhythm", "contents", "content-body", "content-file"]));

    await deny(client, response, status);

    await waitFor(() => expect(descendants(client).map((query) => query.queryKey)).toEqual([]));
    expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull();
    expect(client.getQueryData(sessionKeys.detail(SLUG, SIBLING))).toEqual(unrelated);
    expect(client.getQueryData(sessionKeys.calls(SLUG, SIBLING, "all"))).toBeDefined();
    expect(screen.queryByText(PRIVATE_ARGS)).not.toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_CHILD)).not.toBeInTheDocument();
  });

  it("does not revive denied previews after a later outage or remount, then accepts a fresh authorized read", async () => {
    const response = serveSession();
    const client = retainedClient();
    let view = renderSession(client);
    await screen.findByText(PRIVATE_ARGS);
    await deny(client, response);
    await waitFor(() => expect(descendants(client)).toEqual([]));

    response.status = 500;
    await act(async () => { await client.refetchQueries({ queryKey: sessionKeys.detail(SLUG, SESSION), exact: true }); });
    expect(screen.queryByRole("heading", { name: PRIVATE_TITLE })).not.toBeInTheDocument();
    expect(screen.queryByText(PRIVATE_ARGS)).not.toBeInTheDocument();
    view.unmount();
    view = renderSession(client);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull();
    expect(screen.queryByText(PRIVATE_ARGS)).not.toBeInTheDocument();
    expect(descendants(client)).toEqual([]);

    response.status = 200;
    await act(async () => { await client.refetchQueries({ queryKey: sessionKeys.detail(SLUG, SESSION), exact: true }); });
    expect(await screen.findByRole("heading", { name: PRIVATE_TITLE })).toBeInTheDocument();
    expect(await screen.findByText(PRIVATE_ARGS)).toBeInTheDocument();
    view.unmount();
  });

  it.each(["calls page", "call inspection"] as const)("aborts an in-flight %s on denial and cannot restore its late response", async (surface) => {
    const response = serveSession();
    const client = retainedClient();
    renderSession(client);
    await screen.findByText(PRIVATE_ARGS);
    await waitFor(() => expect(client.isFetching()).toBe(0));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let requestStarted = false;
    let lateResponseReturned = false;
    let outgoingSignal: { readonly aborted: boolean } | undefined;
    const outgoingPath = `/workspaces/${SLUG}/sessions/${SESSION}/calls${surface === "calls page" ? "" : `/${encodeURIComponent(privateCall.key)}`}`;
    const interceptor = api.interceptors.request.use((config) => {
      if (config.url === outgoingPath) outgoingSignal = config.signal;
      return config;
    });
    const transportAbort = vi.spyOn(XMLHttpRequest.prototype, "abort");
    const path = surface === "calls page" ? `${PATH}/calls` : `${PATH}/calls/:key`;
    server.use(http.get(path, async () => {
      requestStarted = true;
      await pending;
      lateResponseReturned = true;
      return HttpResponse.json(surface === "calls page" ? callPage([makeCall({ args_preview: "Late private response" })]) : { key: privateCall.key, events: [] });
    }));
    let refetch: Promise<void> | undefined;
    try {
      if (surface === "calls page") {
        act(() => { refetch = client.refetchQueries({ queryKey: sessionKeys.calls(SLUG, SESSION, "all"), exact: true }); });
      } else {
        await userEvent.click(screen.getByRole("button", { name: /Inspect evidence/ }));
      }
      await waitFor(() => expect(requestStarted).toBe(true));
      expect(outgoingSignal?.aborted).toBe(false);
      await deny(client, response);
      // MSW's XHR adapter synthesizes a Fetch Request without forwarding abort.
      // Observe the real client signal and transport, then release the late body.
      await waitFor(() => expect(outgoingSignal?.aborted).toBe(true));
      expect(transportAbort).toHaveBeenCalledTimes(1);
      await act(async () => { release(); await pending; await refetch; });
      await waitFor(() => expect(lateResponseReturned).toBe(true));
      await waitFor(() => expect(client.isFetching()).toBe(0));

      expect(descendants(client)).toEqual([]);
      expect(client.getQueryData(sessionKeys.detail(SLUG, SESSION))).toBeNull();
      expect(screen.queryByText("Late private response")).not.toBeInTheDocument();
      expect(screen.queryByText(PRIVATE_ARGS)).not.toBeInTheDocument();
    } finally {
      api.interceptors.request.eject(interceptor);
      transportAbort.mockRestore();
      release();
      await refetch;
    }
  });
});
