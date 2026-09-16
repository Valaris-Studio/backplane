// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import { renderWithProviders, screen, waitFor } from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import type { BoardDetail } from "@/types/kanban";

vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: "admin",
    isAdmin: true,
    isLoading: false,
    isError: false,
  }),
}));

import { BoardLoopDialog } from "../BoardLoopDialog";

const SLUG = "acme";
const BOARD_ID = "ops-board";
const BOARD_UUID = "0b7c1e2a-4c1d-4a9a-9c2e-2f6d8f3a1b11";

const LOOP_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/loop`;
const EXECUTIONS_URL = `/api/workspaces/${SLUG}/executions`;
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const GIT_REPOS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_UUID}/git-repos`;

const STORAGE_KEY = "dialog-width:board-loop";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function makeBoard(): BoardDetail {
  return {
    id: BOARD_UUID,
    slug: BOARD_ID,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: false,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    columns: [],
  } as BoardDetail;
}

function makeLoop() {
  return {
    enabled: false,
    provider: "",
    model: "mid",
    system_prompt: "",
    loop_prompt: "keep going",
    tools: [],
    max_iterations: 25,
    iteration_delay_seconds: 30,
    iteration_timeout_seconds: 3600,
    budget_usd: 20.0,
    max_consecutive_failures: 3,
    max_blocked_on_human: 3,
    starvation_policy: "park",
    loop_landing: "human",
    merge_gate: "forge_ci",
    completion_query: null,
    budget_epoch: null,
    disabled_reason: null,
    version: 1,
    updated_at: "2026-07-30T12:00:00Z",
  };
}

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardLoopDialog board={makeBoard()} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

beforeEach(() => {
  window.localStorage.clear();
  setViewportWidth(1600);
  server.use(
    http.get(LOOP_URL, () => HttpResponse.json(makeLoop())),
    http.get(EXECUTIONS_URL, () => HttpResponse.json([])),
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: false,
      }),
    ),
    http.get(GIT_REPOS_URL, () => HttpResponse.json([])),
  );
});

afterEach(() => window.localStorage.clear());

// DialogFooter renders a plain <div> with no data-slot, so the footer is
// located structurally: the ancestor of Save that is a direct child of the
// config <form>. That definition holds both before and after the fix, which is
// what makes the sibling assertions below able to fail on the broken markup.
function findFooter(save: HTMLElement, form: HTMLElement): HTMLElement {
  let node = save.parentElement;
  while (node && node.parentElement !== form) node = node.parentElement;
  if (!node) throw new Error("Save button is not inside the config form");
  return node;
}

async function openDialog() {
  renderDialog();
  const panel = await screen.findByRole("dialog");
  const save = await screen.findByRole("button", { name: /^save$/i });
  const cancel = await screen.findByRole("button", { name: /^cancel$/i });
  const form = panel.querySelector("form") as HTMLElement;
  const footer = findFooter(save, form);
  // The scrolling body is whatever owns overflow-y-auto inside the panel once
  // scroll ownership has moved off the panel itself.
  const scrollBody = panel.querySelector(
    ".overflow-y-auto",
  ) as HTMLElement | null;
  return { panel, save, cancel, form, footer, scrollBody };
}

// Card 66ea32f0 — the panel itself owned overflow-y-auto, so the footer (last
// child of a ~500-line form) scrolled out of reach. Scroll ownership moves to
// an inner body; the footer becomes a pinned flex sibling. Pattern copied from
// CardDetailSheet, which documents the same three-part contract.
describe("BoardLoopDialog — pinned footer", () => {
  it("hands scroll ownership to an inner body, not the dialog panel", async () => {
    const { panel } = await openDialog();

    expect(panel.className).toContain("overflow-hidden");
    expect(panel.className).not.toContain("overflow-y-auto");
  });

  it("keeps the Save button outside the scrolling body", async () => {
    const { save, scrollBody } = await openDialog();

    expect(scrollBody).not.toBeNull();
    expect(scrollBody!.className).toContain("flex-1");
    expect(scrollBody!.contains(save)).toBe(false);
  });

  it("puts both actions in a shrink-0 footer", async () => {
    const { save, cancel, footer } = await openDialog();

    expect(footer).not.toBeNull();
    expect(footer.contains(save)).toBe(true);
    expect(footer.contains(cancel)).toBe(true);
    expect(footer.className).toContain("shrink-0");
  });

  // jsdom has no layout, so computed geometry cannot prove "always visible".
  // The honest structural proxy is that the footer and the scrolling body are
  // flex SIBLINGS: only then does the body absorb overflow while the footer
  // holds its place. Asserting classes alone would pass on markup where the
  // footer still lived inside the scrolled region.
  it("makes the footer a flex sibling of the scrolling body", async () => {
    const { footer, scrollBody } = await openDialog();

    expect(scrollBody).not.toBeNull();
    expect(scrollBody!.contains(footer)).toBe(false);
    expect(footer.parentElement).toBe(scrollBody!.parentElement);
    expect(footer.parentElement!.className).toContain("flex-col");
  });

  it("holds the sibling relationship after the operator resizes the panel", async () => {
    window.localStorage.setItem(STORAGE_KEY, "1180");

    const { panel, footer, scrollBody } = await openDialog();

    await waitFor(() => expect(panel.style.width).toBe("1180px"));
    expect(footer.parentElement).toBe(scrollBody!.parentElement);
    expect(scrollBody!.contains(footer)).toBe(false);
  });
});
