// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { useOwnerSessionList, useOwnerSessionOverview } from "../use-owner-sessions";

const requests: URL[] = [];
const clients: QueryClient[] = [];
let visible = true;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");

function recordRequest({ request }: { request: Request }) { requests.push(new URL(request.url)); }
function emptyOverview() { return { active: [], recent: [], active_more: false, recent_more: false, generated_at: new Date().toISOString() }; }

function session(index: number) {
  return {
    id: `root-${index}`, workspace_id: index % 2 ? "ws-orbit" : "ws-acme", workspace_slug: index % 2 ? "orbit" : "acme",
    workspace_name: index % 2 ? "Orbit" : "Acme", board_id: null, board_name: null, parent_session_id: null,
    harness: "operator_agent", harness_display_name: "Operator agent", title: `needle new query ${index}`,
    repository: null, branch: null, status: "active", display_state: "active",
    started_at: "2026-10-18T11:00:00Z", last_event_at: "2026-10-18T12:00:00Z", ended_at: null,
    ended_reason: null, idle_since: null, event_count: 3, activity_event_count: 2, coverage: "activity",
    capture_gaps: 0, capture_levels: ["standard"], child_count: 0, link_count: 1,
    link_preview: [{ entity_type: "note", entity_id: "note-1", workspace_id: "ws-acme", workspace_slug: "acme", workspace_name: "Acme", board_id: null, board_name: null, title: "Known work", relation: "consulted", provenance: "exact" }],
  };
}

function page(cursor: string | null, next: string) {
  return cursor
    ? { items: [session(40)], next_cursor: null }
    : { items: Array.from({ length: 40 }, (_, index) => session(index)), next_cursor: next };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } });
  clients.push(client);
  // No workspace socket provider: Home/global discovery must refresh even
  // when there is no connected workspace or wildcard subscription.
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function setVisible(next: boolean) {
  visible = next;
  document.dispatchEvent(new Event("visibilitychange"));
  focusManager.setFocused(next);
}

beforeEach(() => {
  requests.length = 0;
  visible = true;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visible ? "visible" : "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => !visible });
  focusManager.setFocused(true);
  server.events.on("request:start", recordRequest);
  server.use(
    http.get("/api/me/sessions/overview", () => HttpResponse.json(emptyOverview())),
    http.get("/api/me/sessions", () => HttpResponse.json({ items: [], next_cursor: null })),
  );
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  server.events.removeListener("request:start", recordRequest);
  vi.useRealTimers();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
  if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
  else Reflect.deleteProperty(document, "hidden");
  focusManager.setFocused(undefined);
});

function overviewReads() { return requests.filter((request) => request.pathname === "/api/me/sessions/overview"); }
function listReads() { return requests.filter((request) => request.pathname === "/api/me/sessions"); }

function freezeIntervalClock() {
  // Keep notification/HTTP/Testing Library timeouts real. Only the product's
  // interval and freshness clock advance; no 30/60-second wall-clock waits.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
}

async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

function renderClockHook<T extends { status: string; fetchStatus: string; dataUpdatedAt: number }>(
  useHook: () => T,
  pageCount: (result: T) => number = () => 0,
) {
  let current: T | undefined;
  function QueryProgressProbe() {
    const observed = useHook();
    useLayoutEffect(() => { current = observed; });
    // waitFor's interval is frozen too. Real query commits must wake its
    // MutationObserver without advancing the product's polling clock.
    return <output aria-label="Owner-session query progress">{observed.status}:{observed.fetchStatus}:{observed.dataUpdatedAt}:{pageCount(observed)}</output>;
  }
  const view = render(<QueryProgressProbe />, { wrapper: wrapper() });
  return { ...view, result: { get current() {
    if (current === undefined) throw new Error("Query progress probe has not committed");
    return current;
  } } };
}

describe("Owner-session hooks — one global authorized HTTP scope", () => {
  it("does not call either endpoint while explicitly disabled and fetches once when capture becomes enabled", async () => {
    const view = renderHook(({ enabled }) => ({
      overview: useOwnerSessionOverview(enabled),
      list: useOwnerSessionList({ root_only: true, sort: "recent" }, enabled),
    }), { initialProps: { enabled: false }, wrapper: wrapper() });
    expect(view.result.current.overview.fetchStatus).toBe("idle");
    expect(view.result.current.list.fetchStatus).toBe("idle");
    expect(requests).toEqual([]);
    view.rerender({ enabled: true });
    await waitFor(() => expect(view.result.current.overview.isSuccess && view.result.current.list.isSuccess).toBe(true));
    expect(overviewReads()).toHaveLength(1);
    expect(listReads()).toHaveLength(1);
    expect(Object.fromEntries(overviewReads()[0]!.searchParams)).toEqual({ active_limit: "6", recent_limit: "6" });
    expect(listReads()[0]!.searchParams.get("limit")).toBe("40");
    expect(listReads()[0]!.searchParams.has("since")).toBe(false);
    expect(listReads()[0]!.searchParams.has("workspace_id")).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it("polls Home at 30 seconds only while visible and refetches on focus only after the 15-second freshness window", async () => {
    freezeIntervalClock();
    const view = renderClockHook(() => useOwnerSessionOverview(true));
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await advance(29_999);
    expect(overviewReads()).toHaveLength(1);
    await advance(1);
    await waitFor(() => expect(overviewReads()).toHaveLength(2));
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    act(() => setVisible(false));
    await advance(90_000);
    expect(overviewReads()).toHaveLength(2);
    act(() => setVisible(true));
    await waitFor(() => expect(overviewReads()).toHaveLength(3));
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    await advance(10_000);
    act(() => { setVisible(false); setVisible(true); });
    expect(overviewReads()).toHaveLength(3);
    await advance(5_001);
    act(() => { setVisible(false); setVisible(true); });
    await waitFor(() => expect(overviewReads()).toHaveLength(4));
  });

  it("uses a 60-second visible first-page interval, stops automatic multi-page walks, and still supports explicit refresh", async () => {
    freezeIntervalClock();
    server.use(http.get("/api/me/sessions", ({ request }) => HttpResponse.json(page(new URL(request.url).searchParams.get("cursor"), "page-two"))));
    const view = renderClockHook(() => useOwnerSessionList({ root_only: true, sort: "recent" }, true), (result) => result.data?.pages.length ?? 0);
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await advance(59_999);
    expect(listReads()).toHaveLength(1);
    await advance(1);
    await waitFor(() => expect(listReads()).toHaveLength(2));
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    act(() => setVisible(false));
    await advance(120_000);
    expect(listReads()).toHaveLength(2);
    act(() => setVisible(true));
    await waitFor(() => expect(listReads()).toHaveLength(3));
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    await act(async () => { await view.result.current.fetchNextPage(); });
    await waitFor(() => expect(view.result.current.data?.pages).toHaveLength(2));
    expect(listReads()).toHaveLength(4);
    expect(listReads()[3]!.searchParams.get("cursor")).toBe("page-two");
    await advance(180_000);
    expect(listReads()).toHaveLength(4);
    await act(async () => { await view.result.current.refetch(); });
    expect(listReads().length).toBeGreaterThan(4);
    await waitFor(() => expect(view.result.current.data?.pages).toHaveLength(2));
    expect(requests.every((request) => request.pathname === "/api/me/sessions")).toBe(true);
  });

  it("keeps repeated server state filters and cursor scope global; a changed filter starts at page one", async () => {
    server.use(http.get("/api/me/sessions", ({ request }) => HttpResponse.json(page(new URL(request.url).searchParams.get("cursor"), "filtered-page-two"))));
    const view = renderHook(({ q }) => useOwnerSessionList({ q, state: ["active", "idle"], root_only: true, sort: "started", linked_only: true }, true), {
      initialProps: { q: "needle" }, wrapper: wrapper(),
    });
    await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
    await act(async () => { await view.result.current.fetchNextPage(); });
    expect(listReads()).toHaveLength(2);
    for (const request of listReads()) {
      expect(request.searchParams.getAll("state")).toEqual(["active", "idle"]);
      expect(request.searchParams.get("q")).toBe("needle");
      expect(request.searchParams.get("sort")).toBe("started");
      expect(request.searchParams.get("linked_only")).toBe("true");
      expect(request.searchParams.get("root_only")).toBe("true");
      expect(request.searchParams.get("limit")).toBe("40");
      expect(request.searchParams.has("workspace_id")).toBe(false);
      expect(request.searchParams.has("since")).toBe(false);
    }
    expect(listReads()[0]!.searchParams.has("cursor")).toBe(false);
    expect(listReads()[1]!.searchParams.get("cursor")).toBe("filtered-page-two");
    view.rerender({ q: "new query" });
    await waitFor(() => expect(listReads()).toHaveLength(3));
    await waitFor(() => expect(view.result.current.isFetching).toBe(false));
    expect(listReads()[2]!.searchParams.get("q")).toBe("new query");
    expect(listReads()[2]!.searchParams.has("cursor")).toBe(false);
    expect(view.result.current.data?.pages).toHaveLength(1);
  });
});
