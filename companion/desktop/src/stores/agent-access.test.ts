// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentAccess } from "../ipc/bindings";
import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { setAgentAccess, useAgentAccess, useAgentAccessRequested } from "./agent-access";
import { applyStreamMessage, startDaemonStream } from "./daemon-stream";

function access(enabled: boolean): AgentAccess {
  return {
    key: { present: enabled, key_prefix: enabled ? "vlr_ab12" : null, server_state: enabled ? "active" : "unknown" },
    prerequisites: { uvx: true },
    mappings: [
      {
        mapping_id: "m1",
        enabled,
        agents: enabled ? [{ agent_id: "claude_code", scope: "folder", state: "configured", problem: null }] : [],
      },
    ],
    warnings: [],
  };
}

const OFF = access(false);
const ON = access(true);

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const fetches = (invoked: string[]) => invoked.filter((command) => command === "agent_access_get").length;

describe("agent access store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches agent access once when a consumer mounts", async () => {
    const daemon = mockDaemonIpc({ agent_access_get: () => OFF });
    const { result } = renderHook(() => useAgentAccess());
    expect(result.current).toBeNull();
    await settle();
    renderHook(() => useAgentAccess());
    await settle();
    expect(result.current).toEqual(OFF);
    expect(fetches(daemon.invoked())).toBe(1);
  });

  it("stays unknown when the daemon can't answer, so nothing is shown as off", async () => {
    mockDaemonIpc({
      agent_access_get: () => {
        throw { kind: "api", status: 501, code: "invalid_request", message: "agent access unavailable", detail: null };
      },
    });
    const { result } = renderHook(() => useAgentAccess());
    await settle();
    expect(result.current).toBeNull();
  });

  it("takes the SSE agent_access event as the new state", async () => {
    const daemon = mockDaemonIpc({ agent_access_get: () => OFF });
    startDaemonStream();
    const { result } = renderHook(() => useAgentAccess());
    await settle();
    act(() => daemon.emit({ type: "agent_access", data: ON }));
    expect(result.current).toEqual(ON);
  });

  it("ignores a malformed agent_access event and keeps what it has", async () => {
    mockDaemonIpc({ agent_access_get: () => OFF });
    const { result } = renderHook(() => useAgentAccess());
    await settle();
    act(() => applyStreamMessage({ type: "agent_access", data: { mappings: "nope" } as unknown as AgentAccess }));
    expect(result.current).toEqual(OFF);
  });

  it("shows the requested value at once, sends it, and takes the daemon's answer", async () => {
    let answer: (value: AgentAccess) => void = () => {};
    const calls: unknown[] = [];
    mockDaemonIpc({
      agent_access_get: () => OFF,
      agent_access_set: (args) => {
        calls.push(args);
        return new Promise<AgentAccess>((resolve) => (answer = resolve));
      },
    });
    const { result } = renderHook(() => ({ access: useAgentAccess(), requested: useAgentAccessRequested("m1") }));
    await settle();
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = setAgentAccess("m1", true);
    });
    expect(result.current.requested).toBe(true);
    expect(calls).toEqual([{ mappingId: "m1", enabled: true }]);
    answer(ON);
    await act(async () => {
      await outcome;
    });
    expect(result.current.access).toEqual(ON);
    expect(result.current.requested).toBeUndefined();
  });

  it("drops the requested value on failure and returns the typed error", async () => {
    mockDaemonIpc({
      agent_access_get: () => OFF,
      agent_access_set: () => {
        throw { kind: "api", status: 409, code: "not_connected", message: "raw", detail: null };
      },
    });
    const { result } = renderHook(() => ({ access: useAgentAccess(), requested: useAgentAccessRequested("m1") }));
    await settle();
    let outcome: Awaited<ReturnType<typeof setAgentAccess>> | undefined;
    await act(async () => {
      outcome = await setAgentAccess("m1", true);
    });
    expect(outcome).toMatchObject({ ok: false, error: { kind: "api", code: "not_connected" } });
    expect(result.current.requested).toBeUndefined();
    expect(result.current.access).toEqual(OFF);
  });

  describe("overlapping toggles", () => {
    type Pending = { resolve: (value: AgentAccess) => void; reject: (error: unknown) => void };

    function deferredSets() {
      const pending: Pending[] = [];
      mockDaemonIpc({
        agent_access_get: () => OFF,
        agent_access_set: () => new Promise<AgentAccess>((resolve, reject) => pending.push({ resolve, reject })),
      });
      return pending;
    }

    function withMapping(id: string, enabled: boolean): AgentAccess {
      return { ...OFF, mappings: [{ mapping_id: id, enabled, agents: [] }] };
    }

    it("keeps the latest toggle's answer when the earlier one resolves last", async () => {
      const pending = deferredSets();
      const { result } = renderHook(() => ({ access: useAgentAccess(), requested: useAgentAccessRequested("m1") }));
      await settle();
      let first: Promise<unknown> = Promise.resolve();
      let second: Promise<unknown> = Promise.resolve();
      act(() => {
        first = setAgentAccess("m1", true);
        second = setAgentAccess("m1", false);
      });
      await settle();
      pending[1]?.resolve(OFF);
      await act(async () => {
        await second;
      });
      pending[0]?.resolve(ON);
      await act(async () => {
        await first;
      });
      expect(result.current.access).toEqual(OFF);
      expect(result.current.requested).toBeUndefined();
    });

    it("keeps the latest request shown while an earlier one settles first", async () => {
      const pending = deferredSets();
      const { result } = renderHook(() => useAgentAccessRequested("m1"));
      await settle();
      let first: Promise<unknown> = Promise.resolve();
      act(() => {
        first = setAgentAccess("m1", true);
        void setAgentAccess("m1", false);
      });
      await settle();
      pending[0]?.resolve(ON);
      await act(async () => {
        await first;
      });
      expect(result.current).toBe(false);
    });

    it("drops a superseded failure: no error to report and the latest state stays", async () => {
      const pending = deferredSets();
      const { result } = renderHook(() => ({ access: useAgentAccess(), requested: useAgentAccessRequested("m1") }));
      await settle();
      let first: Promise<Awaited<ReturnType<typeof setAgentAccess>>> = Promise.resolve(null);
      let second: Promise<unknown> = Promise.resolve();
      act(() => {
        first = setAgentAccess("m1", true);
        second = setAgentAccess("m1", false);
      });
      await settle();
      pending[1]?.resolve(OFF);
      await act(async () => {
        await second;
      });
      pending[0]?.reject({ kind: "api", status: 502, code: "server_unreachable", message: "raw", detail: null });
      let firstOutcome: Awaited<ReturnType<typeof setAgentAccess>> | undefined;
      await act(async () => {
        firstOutcome = await first;
      });
      expect(firstOutcome).toBeNull();
      expect(result.current.access).toEqual(OFF);
      expect(result.current.requested).toBeUndefined();
    });

    it("keeps toggles on different mappings independent", async () => {
      const pending = deferredSets();
      const { result } = renderHook(() => ({ m1: useAgentAccessRequested("m1"), m2: useAgentAccessRequested("m2") }));
      await settle();
      let first: Promise<Awaited<ReturnType<typeof setAgentAccess>>> = Promise.resolve(null);
      act(() => {
        first = setAgentAccess("m1", true);
        void setAgentAccess("m2", true);
      });
      await settle();
      pending[0]?.resolve(withMapping("m1", true));
      let outcome: Awaited<ReturnType<typeof setAgentAccess>> | undefined;
      await act(async () => {
        outcome = await first;
      });
      expect(outcome).toMatchObject({ ok: true });
      expect(result.current).toEqual({ m1: undefined, m2: true });
    });
  });

  it("forgets agent access when the daemon goes away, and fetches again once it is back", async () => {
    const daemon = mockDaemonIpc({ agent_access_get: () => ON });
    startDaemonStream();
    const { result } = renderHook(() => useAgentAccess());
    await settle();
    act(() => daemon.emit({ type: "daemon.unreachable", data: { reason: "socket_unavailable" } }));
    expect(result.current).toBeNull();
    act(() => daemon.emit({ type: "daemon.connected" }));
    await settle();
    expect(result.current).toEqual(ON);
    expect(fetches(daemon.invoked())).toBe(2);
  });

  it("forgets another account's agent access when the device re-pairs", async () => {
    let current = ON;
    const daemon = mockDaemonIpc({ agent_access_get: () => current });
    startDaemonStream();
    const { result } = renderHook(() => useAgentAccess());
    await settle();
    act(() => daemon.emit({ type: "status", data: fixtureStatus }));
    current = OFF;
    act(() => daemon.emit({ type: "status", data: { ...fixtureStatus, installation_id: "another-installation" } }));
    await settle();
    expect(result.current).toEqual(OFF);
  });
});
