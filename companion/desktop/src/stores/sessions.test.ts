// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { LocalSession, SessionEvent } from "../ipc/bindings";
import { applyStreamMessage } from "./daemon-stream";
import { applySessionEvent, sessionsStore } from "./sessions";
import { fixtureStatus } from "../test/daemon-ipc";

function session(id: string, patch: Partial<LocalSession> = {}): LocalSession {
  return {
    native_session_id: id,
    harness: "claude",
    repo: "valaris/backplane",
    mapping_id: null,
    started_at: "2026-09-28T09:00:00Z",
    last_event_at: "2026-09-28T09:00:00Z",
    tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
    cost_estimated_usd: 0.01,
    cost_basis: "api_equivalent",
    auth_kind: "subscription",
    history_deleted: null,
    ...patch,
  };
}

const event = (kind: string, data: LocalSession): SessionEvent => ({ kind, session: data });
const live = () => sessionsStore.get().live;

describe("session store", () => {
  it("adds a started session and counts it as live", () => {
    applySessionEvent(event("started", session("s1")));
    expect(live()).toHaveLength(1);
    expect(live()[0]).toMatchObject({ native_session_id: "s1", harness: "claude", cost_basis: "api_equivalent", auth_kind: "subscription" });
    expect(sessionsStore.get().liveCount).toBe(1);
  });

  it("updates tokens and cost in place, keyed by native_session_id", () => {
    applySessionEvent(event("started", session("s1")));
    applySessionEvent(event("updated", session("s1", { last_event_at: "2026-09-28T09:01:00Z", cost_estimated_usd: 0.5 })));
    expect(live()).toHaveLength(1);
    expect(live()[0]?.cost_estimated_usd).toBe(0.5);
  });

  it("ignores an update older than what it already holds", () => {
    applySessionEvent(event("updated", session("s1", { last_event_at: "2026-09-28T09:05:00Z", cost_estimated_usd: 0.9 })));
    applySessionEvent(event("updated", session("s1", { last_event_at: "2026-09-28T09:02:00Z", cost_estimated_usd: 0.2 })));
    expect(live()[0]?.cost_estimated_usd).toBe(0.9);
  });

  it("treats an update for a session it never saw start as live", () => {
    applySessionEvent(event("updated", session("s9")));
    expect(sessionsStore.get().liveCount).toBe(1);
  });

  it("moves an ended session from live to today's ended list", () => {
    applySessionEvent(event("started", session("s1")));
    applySessionEvent(event("ended", session("s1", { last_event_at: "2026-09-28T09:30:00Z" })));
    expect(live()).toHaveLength(0);
    expect(sessionsStore.get().endedToday.map((ended) => ended.native_session_id)).toEqual(["s1"]);
  });

  it("records an ended event for an unknown id without inventing a live session", () => {
    applySessionEvent(event("ended", session("ghost")));
    expect(live()).toHaveLength(0);
    expect(sessionsStore.get().endedToday).toHaveLength(1);
  });

  it("does not resurrect a session whose late 'started' arrives after it ended", () => {
    applySessionEvent(event("ended", session("s1")));
    applySessionEvent(event("started", session("s1")));
    expect(live()).toHaveLength(0);
  });

  it("ignores an unknown event kind", () => {
    applySessionEvent(event("paused", session("s1")));
    expect(live()).toHaveLength(0);
    expect(sessionsStore.get().endedToday).toHaveLength(0);
  });

  it("does not duplicate sessions when the stream reconnects and replays", () => {
    applyStreamMessage({ type: "session", data: event("started", session("s1")) });
    applyStreamMessage({ type: "session", data: event("started", session("s2")) });
    applyStreamMessage({ type: "session", data: event("ended", session("s2")) });
    applyStreamMessage({ type: "daemon.connected" });
    applyStreamMessage({ type: "status", data: fixtureStatus as never });
    applyStreamMessage({ type: "session", data: event("started", session("s1")) });
    applyStreamMessage({ type: "session", data: event("ended", session("s2")) });
    expect(live().map((entry) => entry.native_session_id)).toEqual(["s1"]);
    expect(sessionsStore.get().endedToday.map((entry) => entry.native_session_id)).toEqual(["s2"]);
  });

  it("drops live sessions when the daemon becomes unreachable, keeping today's ended ones", () => {
    applyStreamMessage({ type: "session", data: event("started", session("s1")) });
    applyStreamMessage({ type: "session", data: event("ended", session("s2")) });
    applyStreamMessage({ type: "daemon.unreachable", data: { reason: "control_file_missing" } });
    expect(live()).toHaveLength(0);
    expect(sessionsStore.get().endedToday).toHaveLength(1);
  });

  it("keeps the live array reference when an event changes nothing", () => {
    applySessionEvent(event("updated", session("s1", { last_event_at: "2026-09-28T09:05:00Z" })));
    const before = live();
    applySessionEvent(event("updated", session("s1", { last_event_at: "2026-09-28T09:01:00Z" })));
    expect(live()).toBe(before);
  });
});
