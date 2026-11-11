// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StrictMode } from "react";
import { fireEvent, getConfig, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { act, waitFor, within } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { WebSocketContext } from "@/providers/WebSocketProvider";
import type { WebSocketEvent } from "@/lib/websocket";
import { useCurrentUser } from "@/features/notifications/api/use-current-user";
import { useOwnerSessionList } from "../use-owner-sessions";

const owner = { id: "coalescing-owner", email: "owner@example.test", name: "Synthetic owner", avatar_url: null };
const workspace = { id: "coalescing-workspace", slug: "coalescing", name: "Coalescing workspace" };
// The accepted A00 window is 2,000 ms. The incumbent constant in
// use-session-realtime.ts is private; this test does not require a new export.
const CAPTURE_BURST_WINDOW_MS = 2000;
const sourcePaths = [
  "src/features/sessions/api/__tests__/use-owner-sessions.coalescing.test.tsx",
  "src/features/sessions/api/use-owner-sessions.ts", "src/features/sessions/api/use-session-realtime.ts",
  "src/hooks/useDomainSync.ts", "src/hooks/use-websocket.ts", "src/features/notifications/api/use-current-user.ts",
];
const hashes = () => Object.fromEntries(sourcePaths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));

function ListProbe() {
  const me = useCurrentUser();
  const list = useOwnerSessionList({ workspace_id: workspace.id, root_only: true, sort: "recent" }, me.isSuccess);
  return <>
    <output aria-label="Owner discovery query state">{list.status}:{list.fetchStatus}:{list.data?.pages[0]?.items[0]?.title ?? "pending"}</output>
    <button type="button" onClick={() => void list.refetch()}>Manual owner discovery refresh</button>
  </>;
}

afterEach(() => { vi.useRealTimers(); });

it("ignores another owner's events, coalesces the owner's spaced capture burst at the trailing 2000 ms edge, and preserves explicit refresh", async (context) => {
  const before = hashes();
  const requests: { path: string; search: string; phase: string; scheduledMs: number; revision?: number }[] = [];
  const unexpected: string[] = [], checkpoints: unknown[] = [];
  const events: { event: string; payload: WebSocketEvent["payload"]; scheduledMs: number }[] = [];
  let phase = "initial", scheduledMs = 0, revision = 0;
  server.use(
    http.get("/api/me", () => {
      requests.push({ path: "/api/me", search: "", phase, scheduledMs });
      return HttpResponse.json(owner);
    }),
    http.get("/api/workspaces", () => {
      requests.push({ path: "/api/workspaces", search: "", phase, scheduledMs });
      return HttpResponse.json([workspace]);
    }),
    http.get("/api/me/sessions", ({ request }) => {
      const url = new URL(request.url);
      const actual = Object.entries(Object.fromEntries(url.searchParams)).sort();
      const expected = Object.entries({ workspace_id: workspace.id, root_only: "true", limit: "40", sort: "recent" }).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        unexpected.push(`Unexpected owner list scope ${url.search}`);
        return HttpResponse.json({ detail: "Unexpected owner list scope" }, { status: 422 });
      }
      revision += 1;
      requests.push({ path: url.pathname, search: url.search, phase, scheduledMs, revision });
      return HttpResponse.json({ items: Array.from({ length: 40 }, (_, index) => ({ id: `coalescing-capture-${index}`, workspace_id: workspace.id, workspace_slug: workspace.slug,
        workspace_name: workspace.name, board_id: null, board_name: null, parent_session_id: null,
        harness: "operator_agent", harness_display_name: "Operator agent", title: index === 0 ? `Durable response ${revision}` : `Retained capture ${index}`,
        repository: null, branch: null, status: "active", display_state: "active", started_at: "2026-10-19T10:00:00Z",
        last_event_at: "2026-10-19T12:00:00Z", ended_at: null, ended_reason: null, idle_since: null,
        event_count: revision, activity_event_count: revision, coverage: "activity", capture_gaps: 0,
        capture_levels: ["standard"], child_count: 0, link_count: 0, link_preview: [],
      })), next_cursor: "not-loaded-page-two" });
    }),
    http.all("*", ({ request }) => {
      unexpected.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ detail: "Unexpected coalescing fixture request" }, { status: 500 });
    }),
  );
  const handlers = new Map<string, Set<(event: WebSocketEvent) => void>>();
  const subscribe = (pattern: string, handler: (event: WebSocketEvent) => void) => {
    const listeners = handlers.get(pattern) ?? new Set();
    listeners.add(handler); handlers.set(pattern, listeners);
    return () => { listeners.delete(handler); };
  };
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: 30_000, gcTime: Infinity, refetchOnWindowFocus: false,
  } } });
  const rendered = render(<StrictMode><QueryClientProvider client={client}>
    <WebSocketContext.Provider value={{ status: "connected", subscribe }}><ListProbe /></WebSocketContext.Provider>
  </QueryClientProvider></StrictMode>);
  const ui = within(rendered.container);
  const listReads = () => requests.filter((request) => request.path === "/api/me/sessions");
  const capture = (name: string) => checkpoints.push({ name, scheduledMs, reads: listReads().length, text: rendered.container.textContent });
  context.onTestFinished(async () => {
    const after = hashes(); capture("final");
    console.info("A03_OWNER_EVENT_COALESCING", JSON.stringify({ before, after, requests, events, checkpoints, unexpected,
      boundary: "Real subscription callback, useDomainSync, Query and HTTP; synthetic context delivery is not server or socket-wire authorization evidence" }));
    rendered.unmount(); await client.cancelQueries(); client.clear(); vi.useRealTimers();
    expect(after).toEqual(before); expect(unexpected).toEqual([]);
    expect([...handlers.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
  await waitFor(() => expect(ui.getByRole("status", { name: "Owner discovery query state" })).toHaveTextContent("success:idle:Durable response 1"));
  context.signal.throwIfAborted(); expect(listReads()).toHaveLength(1);
  expect(handlers.get("agent_session.*")?.size).toBe(1); capture("initial-positive-control");

  // Keep the ordinary observation deadline on the real clock. RTL waitFor's
  // asyncWrapper adds a fake zero-delay drain here that Vitest does not advance.
  const realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
  const observationTimeout = getConfig().asyncUtilTimeout;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  async function settle() {
    context.signal.throwIfAborted();
    await act(async () => {
      if (client.isFetching() !== 0) {
        await new Promise<void>((resolve, reject) => {
          function finish(error?: unknown) {
            unsubscribe(); realClearTimeout(deadline);
            context.signal.removeEventListener("abort", onAbort);
            if (error) reject(error); else resolve();
          }
          function onAbort() { finish(context.signal.reason); }
          function observe() { if (client.isFetching() === 0) finish(); }
          const unsubscribe = client.getQueryCache().subscribe(observe);
          const deadline = realSetTimeout(() => finish(new Error("Actual owner queries did not become idle")), observationTimeout);
          context.signal.addEventListener("abort", onAbort, { once: true });
          if (context.signal.aborted) onAbort(); else observe();
        });
      }
      context.signal.throwIfAborted();
      expect(client.isFetching()).toBe(0);
      // Only deliver notifications already due; never cross a debounce boundary.
      await vi.advanceTimersByTimeAsync(0);
    });
    context.signal.throwIfAborted();
    expect(ui.getByRole("status", { name: "Owner discovery query state" })).toHaveTextContent(`success:idle:Durable response ${revision}`);
  }
  async function advance(ms: number) {
    scheduledMs += ms;
    // Exit the fake clock tick before actual HTTP promises schedule notifications.
    await act(async () => { vi.advanceTimersByTime(ms); }); context.signal.throwIfAborted();
    await settle();
  }
  function send(ownerId: string, sequence: number) {
    context.signal.throwIfAborted();
    const event: WebSocketEvent = { event: "agent_session.updated", timestamp: new Date().toISOString(),
      event_id: `coalescing-event-${sequence}`, payload: { owner_id: ownerId, session_id: "coalescing-capture-0", workspace_id: workspace.id } };
    events.push({ event: event.event, payload: event.payload, scheduledMs });
    expect(handlers.get("agent_session.*")?.size).toBe(1);
    act(() => { handlers.get("agent_session.*")!.forEach((handler) => handler(event)); });
  }

  phase = "another-owner";
  send("another-owner", 1);
  await advance(CAPTURE_BURST_WINDOW_MS);
  expect.soft(listReads(), "another owner's refresh signal must not read this owner's page").toHaveLength(1);
  capture("other-owner-window-complete");

  phase = "owner-spaced-burst";
  const beforeBurst = listReads().length;
  send(owner.id, 2);
  await advance(500);
  expect.soft(listReads(), "first event waits for the capture coalescing edge").toHaveLength(beforeBurst);
  send(owner.id, 3);
  await advance(CAPTURE_BURST_WINDOW_MS - 1);
  expect.soft(listReads(), "second event resets the trailing edge instead of starting an enriched-page storm").toHaveLength(beforeBurst);
  capture("one-ms-before-final-edge");
  await advance(1);
  expect.soft(listReads(), "the whole spaced owner burst produces exactly one first-page HTTP read").toHaveLength(beforeBurst + 1);
  capture("final-edge-complete");

  phase = "manual-refresh";
  const beforeManual = listReads().length;
  await act(async () => { fireEvent.click(ui.getByRole("button", { name: "Manual owner discovery refresh" })); });
  await settle();
  expect(listReads()).toHaveLength(beforeManual + 1);
  expect(ui.getByRole("status", { name: "Owner discovery query state" })).toHaveTextContent(`success:idle:Durable response ${beforeManual + 1}`);
  expect(listReads().every((request) => !new URLSearchParams(request.search).has("cursor"))).toBe(true);
  expect(unexpected).toEqual([]); capture("explicit-refresh-still-works");
});
