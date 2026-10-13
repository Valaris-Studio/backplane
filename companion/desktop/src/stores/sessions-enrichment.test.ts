// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalSession, SessionEvent } from "../ipc/bindings";
import { mockDaemonIpc } from "../test/daemon-ipc";
import { applyStreamMessage } from "./daemon-stream";
import {
  SERVER_SESSIONS_REFRESH_MS,
  applySessionEvent,
  mergeServerSessions,
  serverSessionId,
  sessionsStore,
  startSessionEnrichment,
  useServerSessionId,
} from "./sessions";

function local(id: string, patch: Partial<LocalSession> = {}): LocalSession {
  return {
    native_session_id: id,
    harness: "claude_code",
    repo: "github.com/acme/app",
    mapping_id: null,
    started_at: "2026-09-28T09:00:00Z",
    last_event_at: "2026-09-28T09:10:00Z",
    tokens: { input: 900, output: 400, cache_read: 50, cache_write: 5 },
    cost_estimated_usd: null,
    cost_basis: null,
    auth_kind: null,
    history_deleted: null,
    ...patch,
  };
}

function server(nativeId: string, patch: Record<string, unknown> = {}) {
  return {
    id: `srv-${nativeId}`,
    native_session_id: nativeId,
    input_tokens: 100,
    output_tokens: 40,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_estimated_usd: 1.25,
    cost_reported_usd: 0.75,
    cost_basis: "spend",
    last_event_at: "2026-09-28T09:05:00Z",
    ...patch,
  };
}

const page = (...items: unknown[]) => ({ items, next_cursor: null });
const started = (session: LocalSession): SessionEvent => ({ kind: "started", session });
const ended = (session: LocalSession): SessionEvent => ({ kind: "ended", session });
const live = () => sessionsStore.get().live;

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function sessionsCalls(invoked: string[]): number {
  return invoked.filter((command) => command === "sessions").length;
}

function setPopoverFocused(focused: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(focused);
}

describe("merging the server's own-device sessions", () => {
  it("takes server_id, costs and cost basis by native_session_id", () => {
    applySessionEvent(started(local("s1")));
    applySessionEvent(started(local("s2")));
    mergeServerSessions(page(server("s1"), server("other")));
    expect(live().find((session) => session.native_session_id === "s1")).toMatchObject({
      server_id: "srv-s1",
      cost_estimated_usd: 1.25,
      cost_reported_usd: 0.75,
      cost_basis: "spend",
    });
    expect(live().find((session) => session.native_session_id === "s2")).toMatchObject({ server_id: null, cost_reported_usd: null });
    expect(live()).toHaveLength(2);
  });

  it("never overwrites fresher local token counts", () => {
    applySessionEvent(started(local("s1")));
    mergeServerSessions(page(server("s1")));
    expect(live()[0]?.tokens).toEqual({ input: 900, output: 400, cache_read: 50, cache_write: 5 });
  });

  it("fills token counts the local session does not have", () => {
    applySessionEvent(started(local("s1", { tokens: null })));
    mergeServerSessions(page(server("s1")));
    expect(live()[0]?.tokens).toEqual({ input: 100, output: 40, cache_read: 0, cache_write: 0 });
  });

  it("keeps following the server's tokens while the stream sends none", () => {
    applySessionEvent(started(local("s1", { tokens: null })));
    mergeServerSessions(page(server("s1", { input_tokens: 100 })));
    mergeServerSessions(page(server("s1", { input_tokens: 250, output_tokens: 90 })));
    expect(live()[0]?.tokens).toEqual({ input: 250, output: 90, cache_read: 0, cache_write: 0 });
    applySessionEvent({ kind: "updated", session: local("s1", { last_event_at: "2026-09-28T09:20:00Z", tokens: null }) });
    expect(live()[0]?.tokens).toEqual({ input: 250, output: 90, cache_read: 0, cache_write: 0 });
  });

  it("lets the stream's tokens take over from the server's for good", () => {
    applySessionEvent(started(local("s1", { tokens: null })));
    mergeServerSessions(page(server("s1")));
    const streamed = { input: 900, output: 400, cache_read: 50, cache_write: 5 };
    applySessionEvent({ kind: "updated", session: local("s1", { last_event_at: "2026-09-28T09:20:00Z", tokens: streamed }) });
    mergeServerSessions(page(server("s1", { input_tokens: 5 })));
    expect(live()[0]?.tokens).toEqual(streamed);
  });

  it("keeps facts only for the sessions it holds", () => {
    applySessionEvent(started(local("s1")));
    mergeServerSessions(page(server("s1"), server("elsewhere")));
    expect(serverSessionId("s1")).toBe("srv-s1");
    expect(serverSessionId("elsewhere")).toBeNull();
  });

  it("keeps a local value the server does not know", () => {
    applySessionEvent(started(local("s1", { cost_estimated_usd: 0.3, cost_basis: "api_equivalent" })));
    mergeServerSessions(page(server("s1", { cost_estimated_usd: null, cost_reported_usd: null, cost_basis: null })));
    expect(live()[0]).toMatchObject({ server_id: "srv-s1", cost_estimated_usd: 0.3, cost_basis: "api_equivalent" });
  });

  it("keeps the server's values across later stream updates", () => {
    applySessionEvent(started(local("s1")));
    mergeServerSessions(page(server("s1")));
    applySessionEvent({ kind: "updated", session: local("s1", { last_event_at: "2026-09-28T09:20:00Z", tokens: { input: 1000, output: 500, cache_read: 50, cache_write: 5 } }) });
    expect(live()[0]).toMatchObject({ server_id: "srv-s1", cost_reported_usd: 0.75, tokens: { input: 1000, output: 500, cache_read: 50, cache_write: 5 } });
  });

  it("enriches today's ended sessions too", () => {
    applySessionEvent(ended(local("s1")));
    mergeServerSessions(page(server("s1")));
    expect(sessionsStore.get().endedToday[0]).toMatchObject({ server_id: "srv-s1", cost_estimated_usd: 1.25 });
  });

  it("exposes the server session id for deep links", () => {
    applySessionEvent(started(local("s1")));
    mergeServerSessions(page(server("s1")));
    expect(serverSessionId("s1")).toBe("srv-s1");
    expect(serverSessionId("unknown")).toBeNull();
    const { result } = renderHook(() => useServerSessionId("s1"));
    expect(result.current).toBe("srv-s1");
  });

  it("ignores malformed pages and items without an id", () => {
    applySessionEvent(started(local("s1")));
    const before = live();
    mergeServerSessions(null);
    mergeServerSessions({ items: "nope" });
    mergeServerSessions(page({ native_session_id: "s1" }, { id: "x" }, "junk"));
    expect(live()).toBe(before);
    expect(serverSessionId("s1")).toBeNull();
  });
});

describe("polling the server while the popover is visible", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it("asks for the own-device sessions at once and then every 20 s", async () => {
    setPopoverFocused(true);
    const queries: unknown[] = [];
    const daemon = mockDaemonIpc({
      sessions: (args) => {
        queries.push(args.query);
        return page();
      },
    });
    stop = startSessionEnrichment();
    await settle();
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    expect(queries[0]).toEqual({ status: null, limit: 100, cursor: null });
    await advance(SERVER_SESSIONS_REFRESH_MS - 1);
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    await advance(1);
    expect(sessionsCalls(daemon.invoked())).toBe(2);
    expect(SERVER_SESSIONS_REFRESH_MS).toBe(20_000);
  });

  it("merges what each poll returns", async () => {
    setPopoverFocused(true);
    applySessionEvent(started(local("s1")));
    mockDaemonIpc({ sessions: () => page(server("s1")) });
    stop = startSessionEnrichment();
    await settle();
    expect(serverSessionId("s1")).toBe("srv-s1");
  });

  it("does not poll while the popover is hidden", async () => {
    setPopoverFocused(false);
    const daemon = mockDaemonIpc({ sessions: () => page() });
    stop = startSessionEnrichment();
    await advance(3 * SERVER_SESSIONS_REFRESH_MS);
    expect(sessionsCalls(daemon.invoked())).toBe(0);
  });

  it("starts when the popover is shown and stops when it is hidden again", async () => {
    setPopoverFocused(false);
    const daemon = mockDaemonIpc({ sessions: () => page() });
    stop = startSessionEnrichment();
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    act(() => void window.dispatchEvent(new Event("blur")));
    await advance(3 * SERVER_SESSIONS_REFRESH_MS);
    expect(sessionsCalls(daemon.invoked())).toBe(1);
  });

  it("treats a hidden document as a hidden popover", async () => {
    setPopoverFocused(true);
    const daemon = mockDaemonIpc({ sessions: () => page() });
    stop = startSessionEnrichment();
    await settle();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(3 * SERVER_SESSIONS_REFRESH_MS);
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    visibility.mockRestore();
  });

  it("re-showing the popover within 20 s does not ask again early", async () => {
    setPopoverFocused(true);
    const daemon = mockDaemonIpc({ sessions: () => page() });
    stop = startSessionEnrichment();
    await settle();
    act(() => void window.dispatchEvent(new Event("blur")));
    await advance(5_000);
    act(() => void window.dispatchEvent(new Event("focus")));
    await settle();
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    await advance(SERVER_SESSIONS_REFRESH_MS - 5_000);
    expect(sessionsCalls(daemon.invoked())).toBe(2);
  });

  it("refreshes on an ended event even while hidden", async () => {
    setPopoverFocused(false);
    const daemon = mockDaemonIpc({ sessions: () => page(server("s1")) });
    stop = startSessionEnrichment();
    act(() => applyStreamMessage({ type: "session", data: ended(local("s1")) }));
    await settle();
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    expect(sessionsStore.get().endedToday[0]).toMatchObject({ server_id: "srv-s1" });
  });

  it("throttles a burst of ended events to one call per 20 s, then catches up once", async () => {
    setPopoverFocused(false);
    const daemon = mockDaemonIpc({ sessions: () => page() });
    stop = startSessionEnrichment();
    for (const id of ["a", "b", "c", "d"]) {
      act(() => applyStreamMessage({ type: "session", data: ended(local(id)) }));
    }
    await settle();
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    await advance(SERVER_SESSIONS_REFRESH_MS - 1);
    expect(sessionsCalls(daemon.invoked())).toBe(1);
    await advance(1);
    expect(sessionsCalls(daemon.invoked())).toBe(2);
    await advance(3 * SERVER_SESSIONS_REFRESH_MS);
    expect(sessionsCalls(daemon.invoked())).toBe(2);
  });

  it("ignores server errors silently and keeps the last known values", async () => {
    setPopoverFocused(true);
    applySessionEvent(started(local("s1")));
    let failing = false;
    mockDaemonIpc({
      sessions: () => {
        if (failing) throw { kind: "api", status: 502, code: "server_unreachable", message: "down", detail: null };
        return page(server("s1"));
      },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stop = startSessionEnrichment();
    await settle();
    failing = true;
    await advance(2 * SERVER_SESSIONS_REFRESH_MS);
    expect(live()[0]).toMatchObject({ server_id: "srv-s1", cost_estimated_usd: 1.25 });
    expect(errors).not.toHaveBeenCalled();
  });

  it("stops polling once stopped", async () => {
    setPopoverFocused(true);
    const daemon = mockDaemonIpc({ sessions: () => page() });
    stop = startSessionEnrichment();
    await settle();
    stop();
    stop = undefined;
    await advance(3 * SERVER_SESSIONS_REFRESH_MS);
    act(() => applyStreamMessage({ type: "session", data: ended(local("s1")) }));
    await settle();
    expect(sessionsCalls(daemon.invoked())).toBe(1);
  });
});
