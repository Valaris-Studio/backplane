// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { AlertThresholdList } from "../AlertThresholdList";
import type { AlertThreshold } from "../../api/alerts";

const SLUG = "test-workspace";

const THRESHOLDS: AlertThreshold[] = [
  {
    id: "t-1",
    workspace_id: "ws-1",
    board_id: null,
    name: "Queue backlog",
    metric: "queue_depth",
    operator: "gt",
    value: 10,
    is_active: true,
    created_by_id: "u-1",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  },
];

describe("AlertThresholdList accessibility", () => {
  it("exposes an accessible name on the delete threshold button", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/alerts/thresholds`,
        () => HttpResponse.json(THRESHOLDS),
      ),
    );

    renderWithProviders(<AlertThresholdList slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Queue backlog")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /delete alert threshold/i }),
    ).toBeInTheDocument();
  });
});
