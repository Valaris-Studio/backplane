// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import type { WebSocketEvent } from "@/lib/websocket";
// Pure exported filter factory — unit-testable without a WebSocketProvider
// (subscriptions are inert no-ops in the test harness, so the filter's
// strictness can only be pinned here). Contract:
//   boardLoopEventFilter(routeBoardId, boardUuid) => (evt) => boolean
// matching the useDomainSync `filter` option shape, same strictness precedent
// as the execution filter in use-boards.ts (null must NOT match).
import { boardLoopEventFilter } from "../use-board-loop";
import { boardLoopKeys } from "@/lib/query-keys";
import { boardKeys } from "@/lib/query-keys";

const SLUG_PARAM = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

// board.loop_updated wire payload per the backend contract: board_id is the
// stringified UUID, never the slug.
function makeEvent(boardId: unknown, payloadOverrides = {}): WebSocketEvent {
  return {
    event: "board.loop_updated",
    timestamp: "2026-07-31T00:00:00Z",
    event_id: "evt-1",
    payload: {
      workspace_id: "ws-1",
      board_id: boardId,
      enabled: true,
      version: 2,
      disabled_reason: null,
      ...payloadOverrides,
    },
  };
}

describe("boardLoopEventFilter — strict board scoping", () => {
  it("matches when payload.board_id equals the board UUID", () => {
    const filter = boardLoopEventFilter(SLUG_PARAM, BOARD_UUID);
    expect(filter(makeEvent(BOARD_UUID))).toBe(true);
  });

  it("matches when payload.board_id equals the route param (slug-routed boards)", () => {
    const filter = boardLoopEventFilter(SLUG_PARAM, BOARD_UUID);
    expect(filter(makeEvent(SLUG_PARAM))).toBe(true);
  });

  it("does NOT match a null board_id — null is never this board", () => {
    // Deliberate strictness (use-boards.ts execution-filter precedent): a
    // pass-through on null would refetch this board's loop query for every
    // board-less event in the workspace.
    const filter = boardLoopEventFilter(SLUG_PARAM, BOARD_UUID);
    expect(filter(makeEvent(null))).toBe(false);
  });

  it("does NOT match a missing board_id, an empty payload, or another board", () => {
    const filter = boardLoopEventFilter(SLUG_PARAM, BOARD_UUID);
    expect(filter(makeEvent(undefined))).toBe(false);
    expect(
      filter({
        event: "board.loop_updated",
        timestamp: "2026-07-31T00:00:00Z",
        event_id: "evt-2",
        payload: {},
      }),
    ).toBe(false);
    expect(
      filter(makeEvent("99999999-9999-4999-8999-999999999999")),
    ).toBe(false);
  });

  it("still matches the route param before the board has loaded (uuid undefined), and null still never matches", () => {
    const filter = boardLoopEventFilter(SLUG_PARAM, undefined);
    expect(filter(makeEvent(SLUG_PARAM))).toBe(true);
    expect(filter(makeEvent(null))).toBe(false);
    // An undefined uuid must not turn into an accidental undefined===undefined
    // match for events with no board_id.
    expect(filter(makeEvent(undefined))).toBe(false);
  });
});

describe("boardLoopKeys — top-level key, deliberately outside the board-detail prefix", () => {
  it("scopes by slug and board id and is referentially stable in shape", () => {
    const key = boardLoopKeys.detail("acme", "ops-board");
    expect(key).toContain("acme");
    expect(key).toContain("ops-board");
    expect(key).toEqual(boardLoopKeys.detail("acme", "ops-board"));
  });

  it("does not live under boardKeys.detail — useBoard's five domain invalidations must not churn the loop query", () => {
    const loopKey = boardLoopKeys.detail("acme", "ops-board");
    const detailKey = boardKeys.detail("acme", "ops-board");
    // Prefix-invalidation of ["boards", ...] must never touch the loop key.
    expect(loopKey[0]).not.toBe(detailKey[0]);
  });
});
