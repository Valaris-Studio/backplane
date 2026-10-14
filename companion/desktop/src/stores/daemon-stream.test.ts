// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { attentionStore, connectionStore, startDaemonStream, statusStore } from "./daemon-stream";

async function flushIpc() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("startDaemonStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts in the connecting state before the shell answers", () => {
    mockDaemonIpc();
    startDaemonStream();
    expect(connectionStore.get()).toEqual({ state: "connecting" });
  });

  it("applies connected and status messages from the channel", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    await flushIpc();
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: fixtureStatus });
    expect(connectionStore.get()).toEqual({ state: "connected" });
    expect(statusStore.get()?.capture.state).toBe("active");
  });

  it("reports unreachable and drops the stale status when the daemon goes away", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    await flushIpc();
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: fixtureStatus });
    daemon.emit({ type: "daemon.unreachable", data: { reason: "socket_unavailable" } });
    expect(connectionStore.get()).toEqual({ state: "unreachable", reason: "socket_unavailable" });
    expect(statusStore.get()).toBeNull();
  });

  it("takes the fresh status after the daemon comes back", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    await flushIpc();
    daemon.emit({ type: "daemon.unreachable", data: { reason: "control_file_missing" } });
    daemon.emit({ type: "daemon.connected" });
    const paused = { ...fixtureStatus, capture: { ...fixtureStatus.capture, state: "paused_locally", local_paused: true } };
    daemon.emit({ type: "status", data: paused });
    expect(connectionStore.get()).toEqual({ state: "connected" });
    expect(statusStore.get()?.capture.state).toBe("paused_locally");
  });

  it("keeps attention items from the stream", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    await flushIpc();
    const item = { code: "hook_errors", severity: "warning", agent: "claude_code", message: "Hooks are failing" };
    daemon.emit({ type: "attention", data: { items: [item] } });
    expect(attentionStore.get()).toEqual([item]);
  });

  it("ignores messages it does not render without disturbing state", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    await flushIpc();
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "policy.changed" });
    daemon.emit({ type: "agents", data: [] });
    expect(connectionStore.get()).toEqual({ state: "connected" });
    expect(statusStore.get()).toBeNull();
  });

  it("subscribes only once however often it is started", async () => {
    const daemon = mockDaemonIpc();
    startDaemonStream();
    startDaemonStream();
    await flushIpc();
    expect(daemon.subscribeCalls()).toBe(1);
  });

  it("retries a refused subscription with backoff and reports it unreachable", async () => {
    let refusals = 2;
    const daemon = mockDaemonIpc({
      subscribe_events: () => {
        if (refusals-- > 0) throw "subscribe_events not allowed";
        return null;
      },
    });
    startDaemonStream({ initialRetryMs: 100, maxRetryMs: 1000 });
    await flushIpc();
    expect(connectionStore.get()).toEqual({ state: "unreachable", reason: "ipc" });
    expect(daemon.subscribeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(daemon.subscribeCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(daemon.subscribeCalls()).toBe(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(daemon.subscribeCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(daemon.subscribeCalls()).toBe(3);
  });

  it("stops retrying once stopped", async () => {
    const daemon = mockDaemonIpc({
      subscribe_events: () => {
        throw "subscribe_events not allowed";
      },
    });
    const stop = startDaemonStream({ initialRetryMs: 100 });
    await flushIpc();
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(daemon.subscribeCalls()).toBe(1);
  });
});
