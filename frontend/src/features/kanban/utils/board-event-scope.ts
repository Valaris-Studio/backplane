// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

// Decide whether a WS event belongs to the board currently being viewed.
//
// The trap this exists to avoid: the kanban route is `/:slug/boards/:boardId`,
// but `:boardId` is frequently a board SLUG (e.g. "development-tasks"), while
// every WS event's `payload.board_id` is the board's UUID. Comparing the event
// against the route param alone silently dropped every cross-tab card event.
// So we match against the fetched board's real UUID (`boardUuid`) when known,
// and still accept the route param as a fallback for the brief window before
// the board detail has loaded.
export function eventTargetsBoard(
  event: { payload?: Record<string, unknown> | null },
  board: { routeParam: string; boardUuid: string | undefined },
): boolean {
  const eventBoardId = event.payload?.board_id;
  // A board-scoped event with no board_id is NOT addressed to this board.
  // This used to pass through, on the belief that `column.*` events "may omit
  // the field" — an audit of the backend (card 77c8fc90) disproved it: all 37
  // ActivityService.record sites for card/column/board entities stamp board_id
  // unconditionally. The only sites that omit it are workspace-scoped
  // (workspace/member/channel/git connection), and they publish under event
  // names no board subscription matches. So a missing board_id here means the
  // event belongs to some other scope — dropping it closes a cross-board leak.
  if (eventBoardId === undefined || eventBoardId === null) return false;
  return eventBoardId === board.boardUuid || eventBoardId === board.routeParam;
}
