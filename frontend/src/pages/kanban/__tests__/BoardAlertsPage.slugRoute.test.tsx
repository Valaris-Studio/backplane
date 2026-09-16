// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders } from "@/test/test-utils";

// The :boardId route param also accepts the board's slug, but
// GET /alerts/thresholds?board_id=... is a pydantic UUID query param — a slug
// value 422s. Route param and board UUID are kept DISTINCT (the 43597f1
// fixture pattern) so a hook forwarding the raw param fails loudly.
const SLUG = "acme";
const ROUTE_PARAM = "board2";
const BOARD_UUID = "a1b2c3d4-e5f6-4789-9abc-def012345678";

const paramsState = { current: { slug: SLUG, boardId: ROUTE_PARAM } };
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => paramsState.current,
}));

const useBoardMock = vi.fn();
vi.mock("@/features/kanban/api/use-boards", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useBoard: (...args: unknown[]) => useBoardMock(...args),
}));

const alertThresholdListProps = vi.fn();
vi.mock("@/features/alerts/components/AlertThresholdList", () => ({
  AlertThresholdList: (props: { slug: string; boardId?: string }) => {
    alertThresholdListProps(props);
    return null;
  },
}));

import { BoardAlertsPage } from "../BoardAlertsPage";

beforeEach(() => {
  vi.clearAllMocks();
  paramsState.current = { slug: SLUG, boardId: ROUTE_PARAM };
  useBoardMock.mockReturnValue({ data: { id: BOARD_UUID } });
});

describe("BoardAlertsPage — slug route param vs canonical board id", () => {
  it("passes the board's UUID to AlertThresholdList, not the raw route param", () => {
    renderWithProviders(<BoardAlertsPage />);

    expect(alertThresholdListProps).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, boardId: BOARD_UUID }),
    );
  });

  it("still resolves correctly when the route param already IS the UUID", () => {
    paramsState.current = { slug: SLUG, boardId: BOARD_UUID };
    renderWithProviders(<BoardAlertsPage />);

    expect(alertThresholdListProps).toHaveBeenCalledWith(
      expect.objectContaining({ slug: SLUG, boardId: BOARD_UUID }),
    );
  });
});
