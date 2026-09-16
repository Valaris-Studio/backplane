// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor, userEvent } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

// The :boardId route param also accepts the board's slug, but GET/PUT
// /loop and PATCH /loop/state resolve UUIDs only. BoardLoopDialog.test.tsx's
// own LOOP_URL is built from its BOARD_ID constant, which is the SLUG value —
// so that suite's MSW mocks intercept requests at the buggy sluggy URL and
// pass whether the dialog sends the route param or the UUID. This file pins
// the real contract: the loop GET/PUT/PATCH must hit the board's UUID path,
// even though `board` (a required prop) always carries both. Route param and
// board UUID kept DISTINCT (the 43597f1 fixture pattern) so a raw-param
// regression 404s here instead of silently matching a lenient mock.
const SLUG = "acme";
const ROUTE_PARAM = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const UUID_LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const UUID_STATE_URL = `${UUID_LOOP_URL}/state`;
const SLUG_LOOP_URL = `/api/workspaces/${SLUG}/boards/${ROUTE_PARAM}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;

function makeWorkspaceConfig() {
  return {
    max_rework_attempts: 3,
    card_cooldown_hours: 1,
    commit_message_template: "",
    pr_description_template: "",
    pipeline_config: null,
    version: 1,
    enforce_done_merge_gate: false,
  };
}

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: ROUTE_PARAM,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    loop_configured: true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: false,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "Iterate.",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
    ...overrides,
  };
}

const adminState = { current: { role: "admin" as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin: adminState.current.role === "admin" || adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

import { BoardLoopDialog } from "../BoardLoopDialog";

const SAVE_BUTTON = { name: /^save$/i };

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={<BoardLoopDialog board={makeBoard()} open onOpenChange={() => {}} />}
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${ROUTE_PARAM}/kanban`] } },
  );
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(UUID_LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () => HttpResponse.json(makeWorkspaceConfig())),
  );
});

describe("BoardLoopDialog — loop GET/PUT/PATCH target the board UUID, not the slug route param", () => {
  it("GETs the loop config from the UUID path even when the route param is a slug", async () => {
    let slugRequestSeen = false;
    server.use(
      http.get(SLUG_LOOP_URL, () => {
        slugRequestSeen = true;
        return HttpResponse.json(
          { detail: "not found", error_code: "not_found" },
          { status: 404 },
        );
      }),
    );
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("Iterate."),
    );
    expect(slugRequestSeen).toBe(false);
  });

  it("PUTs a save to the UUID path even when the route param is a slug", async () => {
    let uuidPutCalls = 0;
    let slugPutCalls = 0;
    server.use(
      http.put(UUID_LOOP_URL, async () => {
        uuidPutCalls += 1;
        return HttpResponse.json(makeLoop({ version: 2 }));
      }),
      http.put(SLUG_LOOP_URL, async () => {
        slugPutCalls += 1;
        return HttpResponse.json(makeLoop({ version: 2 }));
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("Iterate."),
    );
    await user.click(screen.getByRole("button", SAVE_BUTTON));

    await waitFor(() => expect(uuidPutCalls).toBe(1));
    expect(slugPutCalls).toBe(0);
  });

  it("PATCHes the toggle to the UUID path even when the route param is a slug", async () => {
    let uuidPatchCalls = 0;
    let slugPatchCalls = 0;
    server.use(
      http.patch(UUID_STATE_URL, async () => {
        uuidPatchCalls += 1;
        return HttpResponse.json(makeLoop({ enabled: true, version: 2 }));
      }),
      http.patch(`${SLUG_LOOP_URL}/state`, async () => {
        slugPatchCalls += 1;
        return HttpResponse.json(makeLoop({ enabled: true, version: 2 }));
      }),
    );
    const user = userEvent.setup();
    renderDialog();

    const toggle = await screen.findByRole("checkbox", { name: /enable/i });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);

    await waitFor(() => expect(uuidPatchCalls).toBe(1));
    expect(slugPatchCalls).toBe(0);
  });

  it("still resolves correctly when the route param already IS the UUID", async () => {
    renderWithProviders(
      <Routes>
        <Route
          path="/:slug/boards/:boardId/*"
          element={<BoardLoopDialog board={makeBoard()} open onOpenChange={() => {}} />}
        />
      </Routes>,
      { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_UUID}/kanban`] } },
    );

    await waitFor(() =>
      expect(screen.getByLabelText(/loop prompt/i)).toHaveValue("Iterate."),
    );
  });
});
