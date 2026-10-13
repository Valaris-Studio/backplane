// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../App";
import type { CompanionStatus } from "../ipc/bindings";
import { startDaemonStream } from "../stores/daemon-stream";
import { fixtureStatus, mockDaemonIpc } from "../test/daemon-ipc";
import { finishOnboarding } from "./navigation";

// The shell tells Rust while onboarding shows, so agent notifications wait for it (DK-12p).
async function renderWith(status: CompanionStatus) {
  const reported: boolean[] = [];
  const daemon = mockDaemonIpc({
    onboarding_active_set: ({ active }) => {
      reported.push(active as boolean);
      return null;
    },
  });
  startDaemonStream();
  render(<App />);
  await act(async () => {});
  act(() => {
    daemon.emit({ type: "daemon.connected" });
    daemon.emit({ type: "status", data: status });
  });
  await act(async () => {});
  return { daemon, reported };
}

describe("onboarding holds agent notifications", () => {
  it("reports onboarding active while the device isn't connected", async () => {
    const { reported } = await renderWith({ ...fixtureStatus, connected: false });
    expect(reported.at(-1)).toBe(true);
  });

  it("reports onboarding over once it finishes, and only on a change", async () => {
    const { daemon, reported } = await renderWith({ ...fixtureStatus, connected: false });
    act(() => daemon.emit({ type: "status", data: fixtureStatus }));
    await act(async () => {});
    expect(reported.at(-1)).toBe(true);
    act(() => finishOnboarding());
    await act(async () => {});
    expect(reported.at(-1)).toBe(false);
    expect(reported.filter((active) => !active)).toHaveLength(1);
  });

  it("reports no onboarding for a device that was already connected", async () => {
    const { reported } = await renderWith(fixtureStatus);
    expect(reported).toEqual([false]);
  });
});
