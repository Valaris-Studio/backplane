// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { eventTargetsBoard } from "./board-event-scope";

const BOARD_UUID = "20b7524b-50bb-42b7-88a5-fd24d15828c4";
const ROUTE_SLUG = "development-tasks";

function evt(boardId?: string | null) {
  return { payload: boardId === undefined ? {} : { board_id: boardId } };
}

describe("eventTargetsBoard", () => {
  it("matches when payload.board_id equals the board's real UUID even though the route param is a slug", () => {
    // The crux of the cross-tab bug: the URL param is the slug, but WS events
    // carry the UUID. Matching only against the param dropped every event.
    expect(
      eventTargetsBoard(evt(BOARD_UUID), { routeParam: ROUTE_SLUG, boardUuid: BOARD_UUID }),
    ).toBe(true);
  });

  it("still matches against the route param (covers the pre-load window before the UUID is known)", () => {
    expect(
      eventTargetsBoard(evt(ROUTE_SLUG), { routeParam: ROUTE_SLUG, boardUuid: undefined }),
    ).toBe(true);
  });

  it("rejects events for a different board", () => {
    expect(
      eventTargetsBoard(evt("ffffffff-0000-0000-0000-000000000000"), {
        routeParam: ROUTE_SLUG,
        boardUuid: BOARD_UUID,
      }),
    ).toBe(false);
  });

  // Backend audit (card 77c8fc90): all 37 card/column/board-entity
  // ActivityService.record sites stamp board_id unconditionally. The 10 sites
  // that omit it are workspace-scoped entities (workspace/member/channel/git
  // connection) whose event names no board subscription matches. So a
  // board-scoped event reaching this filter without a board_id is not "a
  // column event legitimately omitting the field" — it is another board's
  // event, or a workspace event that leaked into a board subscription.
  it("rejects board-scoped events that carry no board_id", () => {
    expect(
      eventTargetsBoard(evt(undefined), { routeParam: ROUTE_SLUG, boardUuid: BOARD_UUID }),
    ).toBe(false);
    expect(
      eventTargetsBoard(evt(null), { routeParam: ROUTE_SLUG, boardUuid: BOARD_UUID }),
    ).toBe(false);
  });

  it("rejects a column.updated event belonging to a different board", () => {
    // The leak the null-pass left open: column.* events were waved through
    // regardless of origin, so another board's column rename invalidated this
    // board's cache.
    expect(
      eventTargetsBoard(evt("ffffffff-0000-0000-0000-000000000000"), {
        routeParam: ROUTE_SLUG,
        boardUuid: BOARD_UUID,
      }),
    ).toBe(false);
    expect(
      eventTargetsBoard(evt(undefined), { routeParam: ROUTE_SLUG, boardUuid: BOARD_UUID }),
    ).toBe(false);
  });

  it("still accepts an event whose board_id matches while the board detail is still loading", () => {
    // Tightening must not break the pre-load window: before the UUID resolves,
    // the route param is the only thing to match against.
    expect(
      eventTargetsBoard(evt(ROUTE_SLUG), { routeParam: ROUTE_SLUG, boardUuid: undefined }),
    ).toBe(true);
  });

  it("matches the param when it happens to BE the uuid (board navigated by id)", () => {
    expect(
      eventTargetsBoard(evt(BOARD_UUID), { routeParam: BOARD_UUID, boardUuid: BOARD_UUID }),
    ).toBe(true);
  });
});
