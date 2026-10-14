// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { applyStreamMessage, resetDaemonStreamForTests } from "./daemon-stream";
import { pairingStore, usePairingEvents } from "./pairing";

afterEach(() => resetDaemonStreamForTests());

describe("pairing store", () => {
  it("keeps the latest pairing event from the stream", () => {
    applyStreamMessage({ type: "pairing", data: { pairing_id: "p1", state: "pending" } });
    applyStreamMessage({ type: "pairing", data: { pairing_id: "p1", state: "connected" } });
    expect(pairingStore.get()).toEqual({ pairing_id: "p1", state: "connected" });
  });

  it("usePairingEvents follows only the pairing asked for", () => {
    const { result } = renderHook(() => usePairingEvents("p2"));
    expect(result.current).toBeNull();
    act(() => applyStreamMessage({ type: "pairing", data: { pairing_id: "p1", state: "denied" } }));
    expect(result.current).toBeNull();
    act(() => applyStreamMessage({ type: "pairing", data: { pairing_id: "p2", state: "expired" } }));
    expect(result.current).toEqual({ pairing_id: "p2", state: "expired" });
  });

  it("usePairingEvents without an id follows every pairing", () => {
    const { result } = renderHook(() => usePairingEvents());
    act(() => applyStreamMessage({ type: "pairing", data: { pairing_id: "p9", state: "pending" } }));
    expect(result.current?.pairing_id).toBe("p9");
  });

  it("forgets pairing events on reset", () => {
    applyStreamMessage({ type: "pairing", data: { pairing_id: "p1", state: "pending" } });
    resetDaemonStreamForTests();
    expect(pairingStore.get()).toBeNull();
  });
});
