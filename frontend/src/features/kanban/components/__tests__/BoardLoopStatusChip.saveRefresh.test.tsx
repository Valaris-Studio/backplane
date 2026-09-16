// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  renderWithProviders,
  screen,
  waitFor,
  userEvent,
} from "@/test/test-utils";
import { http, HttpResponse, server } from "@/test/msw-server";
import {
  useBoardLoopStatus,
  resolveLoopChipState,
} from "@/features/kanban/api/use-board-loop-status";
import {
  useSaveBoardLoop,
  BOARD_LOOP_DEFAULTS,
} from "@/features/kanban/api/use-board-loop";
import { BoardLoopStatusChip } from "../BoardLoopStatusChip";

// Card 9dafe313 (AC1) — the owner's field report end to end: save the loop
// config, the chip must show the new state with NO page refresh. The hook-level
// tests pin the invalidation wiring; this one pins what the operator actually
// sees, so a future refactor that keeps the invalidation but breaks the render
// path still goes red. Real chip, real status hook, real save mutation — only
// the network is faked.
const SLUG = "acme";
const BOARD_ID = "board-1";

// The server's answer to GET /loop/status, mutated by the PUT handler below so
// the refetch observes a genuinely different payload — the whole point of the
// bug is that the client never asks again.
const serverState = { enabled: false, state: "off" as "off" | "waiting" };

function makeStatus() {
  return {
    state: serverState.state,
    enabled: serverState.enabled,
    disabled_reason: null,
    actionable: true,
    has_inflight_iteration: false,
    last_iteration_at: null,
    last_iteration_status: null,
    bound_agent_count: 1,
    alive_agent_count: 1,
    spent_usd: 0,
    budget_usd: null,
  };
}

beforeEach(() => {
  serverState.enabled = false;
  serverState.state = "off";
  server.use(
    http.get("/api/workspaces/:slug/boards/:boardId/loop/status", () =>
      HttpResponse.json(makeStatus()),
    ),
    http.put("/api/workspaces/:slug/boards/:boardId/loop", async () => {
      serverState.enabled = true;
      serverState.state = "waiting";
      return HttpResponse.json({ ...BOARD_LOOP_DEFAULTS, enabled: true });
    }),
  );
});

// Minimal stand-in for the loop dialog's save button wired to the real
// mutation — the dialog's own form is out of scope here, the convergence is not.
function LoopChipHarness() {
  const { data: status } = useBoardLoopStatus(SLUG, BOARD_ID, BOARD_ID);
  const save = useSaveBoardLoop(SLUG, BOARD_ID);

  return (
    <div>
      <BoardLoopStatusChip
        state={resolveLoopChipState(status)}
        status={status}
        onClick={() => {}}
      />
      <button
        type="button"
        onClick={() =>
          save.mutate({
            ...BOARD_LOOP_DEFAULTS,
            enabled: true,
            tools: [],
            completion_query: {},
          })
        }
      >
        Save loop
      </button>
    </div>
  );
}

describe("loop status chip refreshes on save (card 9dafe313)", () => {
  it("flips off → waiting after the config save, with no remount", async () => {
    // Explicit client rather than the default harness one: createTestQueryClient
    // sets gcTime: 0, which evicts the status entry the moment the query is
    // between observers and would mask a missing invalidation behind a refetch
    // that happens for the wrong reason.
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    renderWithProviders(<LoopChipHarness />, { queryClient: client });

    const chip = await screen.findByTestId("loop-status-chip");
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "off"));

    await userEvent.click(screen.getByRole("button", { name: "Save loop" }));

    // Same DOM node throughout: this is a live update, not a re-mount.
    await waitFor(() => expect(chip).toHaveAttribute("data-state", "waiting"));
    expect(chip).toHaveTextContent("Loop waiting");
  });
});
