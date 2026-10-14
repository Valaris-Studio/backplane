// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../../App";
import { popoverVisibleStore } from "../../shell/popover-visibility";
import { startDaemonStream } from "../../stores/daemon-stream";
import { mockDaemonIpc } from "../../test/daemon-ipc";
import { NOW, baseStatus, boards, claudeSession, codexSession, projects, sessionEvent } from "./home-fixtures";

const rowRenders = vi.hoisted(() => new Map<string, number>());

vi.mock("./SessionRowView", async (importOriginal) => {
  const original = await importOriginal<typeof import("./SessionRowView")>();
  return {
    ...original,
    SessionRowView: (props: Parameters<typeof original.SessionRowView>[0]) => {
      const id = props.session.native_session_id;
      rowRenders.set(id, (rowRenders.get(id) ?? 0) + 1);
      return original.SessionRowView(props);
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"], now: NOW });
  popoverVisibleStore.set(true);
  rowRenders.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Home session rows", () => {
  it("re-render only the row whose session changed, not on clock ticks or status updates", async () => {
    const daemon = mockDaemonIpc({ boards: () => boards, projects: () => projects });
    startDaemonStream();
    render(<App />);
    await act(async () => {});
    act(() => {
      daemon.emit({ type: "daemon.connected" });
      daemon.emit({ type: "status", data: baseStatus });
      daemon.emit({ type: "session", data: sessionEvent("started", claudeSession) });
      daemon.emit({ type: "session", data: sessionEvent("started", codexSession) });
    });
    await act(async () => {});
    const settledCodex = rowRenders.get("sess-codex") ?? 0;
    const settledClaude = rowRenders.get("sess-claude") ?? 0;

    act(() => vi.advanceTimersByTime(3_000));
    act(() => daemon.emit({ type: "status", data: { ...baseStatus, queue: { ...baseStatus.queue, records: 9 } } }));
    act(() =>
      daemon.emit({
        type: "session",
        data: sessionEvent("updated", { ...claudeSession, last_event_at: new Date(NOW.getTime() + 500).toISOString(), cost_estimated_usd: 2 }),
      }),
    );

    expect(rowRenders.get("sess-codex")).toBe(settledCodex);
    expect(rowRenders.get("sess-claude")).toBe(settledClaude + 1);
  });
});
