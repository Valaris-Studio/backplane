// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentEntry } from "../ipc/bindings";
import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { applyStreamMessage, startDaemonStream } from "./daemon-stream";
import { useAgent, useAgents } from "./agents";

function agent(id: string, state = "installed"): AgentEntry {
  return {
    id,
    presence: { installed: true, version: "1.0.0", config_path: `~/.${id}/settings.json` },
    integration: { state, config_path: `~/.${id}/settings.json`, problems: [], notes: [], trust: null },
    action: null,
    telemetry: null,
  };
}

const INITIAL = [agent("claude_code"), agent("codex_cli", "not_installed")];

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const fetches = (invoked: string[]) => invoked.filter((command) => command === "agents").length;

describe("agents store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fetches the agents once when a consumer mounts", async () => {
    const daemon = mockDaemonIpc({ agents: () => INITIAL });
    const { result } = renderHook(() => useAgents());
    expect(result.current).toEqual([]);
    await settle();
    expect(result.current).toEqual(INITIAL);
    expect(fetches(daemon.invoked())).toBe(1);
  });

  it("looks one agent up by id, null when unknown", async () => {
    mockDaemonIpc({ agents: () => INITIAL });
    const { result } = renderHook(() => ({ codex: useAgent("codex_cli"), cursor: useAgent("cursor") }));
    await settle();
    expect(result.current.codex?.integration?.state).toBe("not_installed");
    expect(result.current.cursor).toBeNull();
  });

  it("serves re-renders and further consumers from the cache", async () => {
    const daemon = mockDaemonIpc({ agents: () => INITIAL });
    const { rerender } = renderHook(() => useAgents());
    renderHook(() => useAgent("claude_code"));
    await settle();
    rerender();
    renderHook(() => useAgents());
    await settle();
    expect(fetches(daemon.invoked())).toBe(1);
  });

  it("takes the SSE agents event as the new list", async () => {
    const daemon = mockDaemonIpc({ agents: () => INITIAL });
    startDaemonStream();
    const { result } = renderHook(() => useAgent("codex_cli"));
    await settle();
    act(() => daemon.emit({ type: "agents", data: [agent("codex_cli", "installed")] }));
    expect(result.current?.integration?.state).toBe("installed");
  });

  it("lets an event that lands during the first fetch win over the stale fetch", async () => {
    let answer: (agents: AgentEntry[]) => void = () => {};
    mockDaemonIpc({ agents: () => new Promise<AgentEntry[]>((resolve) => (answer = resolve)) });
    const { result } = renderHook(() => useAgents());
    await settle();
    act(() => applyStreamMessage({ type: "agents", data: [agent("pi_cli")] }));
    answer(INITIAL);
    await settle();
    expect(result.current.map((entry) => entry.id)).toEqual(["pi_cli"]);
  });

  it("ignores a malformed agents event", async () => {
    mockDaemonIpc({ agents: () => INITIAL });
    const { result } = renderHook(() => useAgents());
    await settle();
    act(() => applyStreamMessage({ type: "agents", data: { not: "a list" } as never }));
    act(() => applyStreamMessage({ type: "agents", data: [{ nope: true }] as never }));
    expect(result.current).toEqual(INITIAL);
  });

  it("stays empty without throwing when the daemon is down, and tries again on the next mount", async () => {
    let down = true;
    const daemon = mockDaemonIpc({
      agents: () => {
        if (down) throw { kind: "unreachable", reason: "socket_unavailable" };
        return INITIAL;
      },
    });
    const first = renderHook(() => useAgents());
    await settle();
    expect(first.result.current).toEqual([]);
    first.unmount();
    down = false;
    const second = renderHook(() => useAgents());
    await settle();
    expect(second.result.current).toEqual(INITIAL);
    expect(fetches(daemon.invoked())).toBe(2);
  });

  it("refetches after the daemon comes back, since events were missed meanwhile", async () => {
    let current = INITIAL;
    const daemon = mockDaemonIpc({ agents: () => current });
    const { result } = renderHook(() => useAgents());
    await settle();
    current = [agent("claude_code", "broken")];
    act(() => applyStreamMessage({ type: "daemon.unreachable", data: { reason: "socket_unavailable" } }));
    act(() => applyStreamMessage({ type: "daemon.connected" }));
    await settle();
    expect(fetches(daemon.invoked())).toBe(2);
    expect(result.current[0]?.integration?.state).toBe("broken");
  });

  it("drops the agents while the daemon is unreachable and refetches once it is back", async () => {
    const daemon = mockDaemonIpc({ agents: () => INITIAL });
    const { result } = renderHook(() => useAgents());
    await settle();
    act(() => applyStreamMessage({ type: "daemon.unreachable", data: { reason: "socket_unavailable" } }));
    expect(result.current).toEqual([]);
    act(() => applyStreamMessage({ type: "daemon.connected" }));
    await settle();
    expect(result.current).toEqual(INITIAL);
    expect(fetches(daemon.invoked())).toBe(2);
  });

  it("refetches when another installation takes over", async () => {
    let current = INITIAL;
    const daemon = mockDaemonIpc({ agents: () => current });
    applyStreamMessage({ type: "status", data: { ...fixtureStatus, installation_id: "inst-a" } });
    const { result } = renderHook(() => useAgents());
    await settle();
    current = [agent("pi_cli")];
    act(() => applyStreamMessage({ type: "status", data: { ...fixtureStatus, installation_id: "inst-b" } }));
    expect(result.current).toEqual([]);
    await settle();
    expect(fetches(daemon.invoked())).toBe(2);
    expect(result.current.map((entry) => entry.id)).toEqual(["pi_cli"]);
  });
});
