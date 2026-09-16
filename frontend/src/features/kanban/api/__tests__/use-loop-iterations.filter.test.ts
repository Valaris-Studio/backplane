// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { boardLoopIterationsEventFilter } from "../use-loop-iterations";
import type { WebSocketEvent } from "@/lib/websocket";

const BOARD_UUID = "0b7c1e2a-1111-2222-3333-444455556666";
const ROUTE_ID = "board-route-id";

const evt = (board_id: unknown): WebSocketEvent =>
  ({
    event: "execution.started",
    event_id: "evt-1",
    timestamp: "2026-08-01T00:00:00Z",
    payload: { board_id },
  }) as unknown as WebSocketEvent;

describe("boardLoopIterationsEventFilter", () => {
  const filter = boardLoopIterationsEventFilter(ROUTE_ID, BOARD_UUID);

  it("ignores execution events with a null board_id (non-board stage — no refetch storm)", () => {
    // Same strictness contract as use-boards.ts's execution subscription: a
    // board-less execution must never invalidate a board-scoped cache. Pinned
    // here because the adversarial pass proved a null-passing mutant survived
    // every other test in the card's suite.
    expect(filter(evt(null))).toBe(false);
    expect(filter(evt(undefined))).toBe(false);
  });

  it("matches the board's UUID and the route param, nothing else", () => {
    expect(filter(evt(BOARD_UUID))).toBe(true);
    expect(filter(evt(ROUTE_ID))).toBe(true);
    expect(filter(evt("some-other-board"))).toBe(false);
  });

  it("stays strict when the board UUID has not resolved yet", () => {
    const unresolved = boardLoopIterationsEventFilter(ROUTE_ID, undefined);
    expect(unresolved(evt(null))).toBe(false);
    expect(unresolved(evt(ROUTE_ID))).toBe(true);
    expect(unresolved(evt(BOARD_UUID))).toBe(false);
  });
});
