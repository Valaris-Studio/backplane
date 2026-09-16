// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { http, HttpResponse, server } from "@/test/msw-server";
import { createTestQueryClient } from "@/test/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { useAddTeamMember } from "../useTeams";

const SLUG = "test-workspace";
const TEAM_ID = "team-1";

function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

describe("useAddTeamMember", () => {
  it("fires a success toast interpolated with member and team names", async () => {
    server.use(
      http.post(
        `/api/workspaces/${SLUG}/teams/${TEAM_ID}/members`,
        () =>
          HttpResponse.json({
            id: TEAM_ID,
            slug: "squad",
            name: "Squad",
            description: "",
            workspace_id: "ws-1",
            board_id: null,
            created_by_id: "u-1",
            is_active: true,
            members: [
              {
                agent_id: "agent-42",
                agent_name: "coder-bot",
                agent_type: "coding",
                roles: ["orchestrator"],
                role_warnings: [],
                added_at: "2026-04-18T00:00:00Z",
              },
            ],
            created_at: "2026-04-18T00:00:00Z",
            updated_at: "2026-04-18T00:00:00Z",
          }),
      ),
    );

    const { result } = renderHook(() => useAddTeamMember(SLUG), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        teamId: TEAM_ID,
        data: { agent_id: "agent-42", roles: ["orchestrator"] },
        memberName: "coder-bot",
        teamName: "Squad",
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled();
    });
    const msg = (toast.success as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(msg).toContain("coder-bot");
    expect(msg).toContain("Squad");
  });
});
