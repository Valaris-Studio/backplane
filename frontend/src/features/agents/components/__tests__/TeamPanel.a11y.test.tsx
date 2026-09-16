// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import { TeamPanel } from "../TeamPanel";
import type { TeamRead } from "../../api/teams";

const SLUG = "test-workspace";

const TEAMS: TeamRead[] = [
  {
    id: "team-1",
    slug: "squad-one",
    name: "Squad One",
    description: "",
    workspace_id: "ws-1",
    board_id: null,
    created_by_id: "u-1",
    is_active: true,
    members: [],
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  },
];

describe("TeamPanel accessibility", () => {
  it("exposes accessible names on the add-member and deactivate buttons", async () => {
    server.use(
      http.get(
        `/api/workspaces/${SLUG}/teams`,
        () => HttpResponse.json(TEAMS),
      ),
    );

    renderWithProviders(<TeamPanel slug={SLUG} />);

    await waitFor(() => {
      expect(screen.getByText("Squad One")).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /add team member/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /deactivate team/i }),
    ).toBeInTheDocument();
  });
});
