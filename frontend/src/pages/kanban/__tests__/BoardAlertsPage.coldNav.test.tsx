// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// Cold direct navigation to /boards/<slug>/alerts: useBoard's cache is EMPTY
// (no BoardLayout mount before it, e.g. a bookmarked/shared link straight to
// the alerts tab), so `board?.id` is undefined for at least one render tick
// before the board detail GET resolves. useAlertThresholds has no `enabled`
// gate (boardId ? byBoard : byWorkspace fires unconditionally), so a
// `?? routeBoardId` fallback sends exactly one sluggy, 422-triggering request
// during that window. `?? ""` must hold the fetch until the board resolves
// instead. Route param and board UUID kept DISTINCT (the 43597f1 fixture
// pattern).
const SLUG = "acme";
const ROUTE_PARAM = "board2";
const BOARD_UUID = "f1e2d3c4-b5a6-4978-8261-534fedcba098";

const BOARD_URL = `/api/workspaces/${SLUG}/boards/${ROUTE_PARAM}`;
const THRESHOLDS_URL = `/api/workspaces/${SLUG}/alerts/thresholds`;

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: ROUTE_PARAM,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

import { BoardAlertsPage } from "../BoardAlertsPage";

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/:slug/boards/:boardId/*" element={<BoardAlertsPage />} />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/alerts`] } },
  );
}

beforeEach(() => {
  server.use(http.get(BOARD_URL, () => HttpResponse.json(makeBoard())));
});

describe("BoardAlertsPage — cold direct navigation to a slug URL", () => {
  it("never requests thresholds with the raw slug as board_id, even before the board resolves", async () => {
    let sluggyRequestSeen = false;
    let uuidRequestSeen = false;
    server.use(
      http.get(THRESHOLDS_URL, ({ request }) => {
        const boardIdParam = new URL(request.url).searchParams.get("board_id");
        if (boardIdParam === ROUTE_PARAM) sluggyRequestSeen = true;
        if (boardIdParam === BOARD_UUID) uuidRequestSeen = true;
        return HttpResponse.json([]);
      }),
    );

    renderPage();

    await waitFor(() => expect(uuidRequestSeen).toBe(true));
    expect(sluggyRequestSeen).toBe(false);
  });
});
