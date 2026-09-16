// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Route, Routes } from "react-router-dom";
import {
  renderWithProviders,
  screen,
  waitFor,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";
import i18n from "@/i18n/config";
import type { Board } from "@/types/kanban";

// Same admin-gate mock idiom as BoardSettingsDialog.skills.test.tsx.
const adminState = { current: { role: null as string | null } };
vi.mock("@/hooks/useWorkspaceAdmin", () => ({
  useWorkspaceAdmin: () => ({
    role: adminState.current.role,
    isAdmin:
      adminState.current.role === "admin" ||
      adminState.current.role === "owner",
    isLoading: false,
    isError: false,
  }),
}));

import { BoardSettingsDialog } from "../BoardSettingsDialog";

// MCP #3 — the board settings skills tab is the drift-banner path for skills.
// Each RAW binding row carries `toolsets` (the resolved version's declared
// hand) and `uncovered_toolsets` (declared toolsets the board's loop grant
// cannot cover). The tab renders one chip per toolset id and, when anything is
// uncovered, a warning banner naming the ids with a hint to widen the loop
// config's `tools`.
//
// Pinned shapes the implementer must match:
//   data-testid="skill-toolset-chip"      one per toolset id, text = raw id
//   data-testid="skill-uncovered-banner"  the warning (absent when covered)
//   i18n key skills.boardSection.uncoveredBanner — the banner copy
//   (interpolates the ids; the static prefix before `{{` must render)

const SLUG = "acme";
const BOARD_ID = "board-1";
const CONFIG_URL = `/api/workspaces/${SLUG}/config`;
const WORKSPACE_SKILLS_URL = `/api/workspaces/${SLUG}/skills`;
const BOARD_SKILLS_URL = `/api/workspaces/${SLUG}/boards/${BOARD_ID}/skills`;
const BOARD_BINDINGS_URL = `${BOARD_SKILLS_URL}/bindings`;
const CHIP = "skill-toolset-chip";
const BANNER = "skill-uncovered-banner";

function binding(overrides: Record<string, unknown> = {}) {
  return {
    skill_id: "skill-1",
    slug: "release-checklist",
    name: "Release Checklist",
    enabled: true,
    pinned_version: null,
    role: null,
    resolved_version: 2,
    toolsets: ["cards"],
    uncovered_toolsets: [] as string[],
    ...overrides,
  };
}

// The workspace list entry deliberately declares NO toolsets: the chips on a
// binding row come from the binding (the resolved/pinned version's hand), not
// from the workspace skill's latest published version — the two can differ
// when a board pins an older version.
const RELEASE_CHECKLIST_LIST_ITEM = {
  id: "skill-1",
  slug: "release-checklist",
  name: "Release Checklist",
  description: "Steps for tagging and shipping a release",
  latest_published_version: 2,
  origin: null,
  updated_at: "2026-08-20T10:00:00Z",
  archived_at: null,
  toolsets: [] as string[],
};

const RELEASE_CHECKLIST_DETAIL = {
  ...RELEASE_CHECKLIST_LIST_ITEM,
  lint_warnings: [] as string[],
  versions: [
    {
      version: 2,
      status: "published",
      content_hash: "hash-rc-2",
      created_at: "2026-08-20T10:00:00Z",
    },
  ],
};

function makeBoard(): Board {
  return {
    id: BOARD_ID,
    slug: null,
    name: "Ops Board",
    description: "",
    tags: [],
    workspace_id: "ws-1",
    is_frozen: false,
    enforce_done_merge_gate: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
  } as Board;
}

function renderDialog() {
  return renderWithProviders(
    <Routes>
      <Route
        path="/:slug/boards/:boardId/*"
        element={
          <BoardSettingsDialog board={makeBoard()} open onOpenChange={() => {}} />
        }
      />
    </Routes>,
    { routerProps: { initialEntries: [`/${SLUG}/boards/${BOARD_ID}/kanban`] } },
  );
}

function stubBindings(bindings: ReturnType<typeof binding>[]) {
  server.use(
    http.get(BOARD_BINDINGS_URL, () => HttpResponse.json({ bindings })),
  );
}

// The per-skill toggle may be a Switch or a Checkbox; its accessible name is
// the skill's name. Its closest row container is where chips/banner live.
async function findSkillRow(name: RegExp) {
  return waitFor(() => {
    const toggle =
      screen.queryByRole("switch", { name }) ??
      screen.queryByRole("checkbox", { name });
    expect(toggle).toBeInTheDocument();
    return toggle as HTMLElement;
  });
}

function bannerCopyPrefix() {
  const key = "skills.boardSection.uncoveredBanner";
  const value = i18n.t(key);
  expect(value, `${key} is missing from en.json`).not.toBe(key);
  return (value.split("{{")[0] ?? "").trim();
}

beforeEach(() => {
  adminState.current.role = "admin";
  server.use(
    http.get(CONFIG_URL, () =>
      HttpResponse.json({
        max_rework_attempts: 3,
        card_cooldown_hours: 1,
        commit_message_template: "",
        pr_description_template: "",
        pipeline_config: null,
        version: 1,
        enforce_done_merge_gate: true,
      }),
    ),
    http.get(WORKSPACE_SKILLS_URL, () =>
      HttpResponse.json({ skills: [RELEASE_CHECKLIST_LIST_ITEM], count: 1 }),
    ),
    http.get(`${WORKSPACE_SKILLS_URL}/release-checklist`, () =>
      HttpResponse.json(RELEASE_CHECKLIST_DETAIL),
    ),
  );
});

describe("BoardSettingsDialog — skill toolsets and loop-grant coverage", () => {
  it("renders a chip per binding-row toolset and no banner when everything is covered", async () => {
    stubBindings([binding({ toolsets: ["cards"], uncovered_toolsets: [] })]);
    renderDialog();

    await findSkillRow(/release checklist/i);
    await waitFor(() => {
      expect(
        screen.getAllByTestId(CHIP).map((chip) => chip.textContent?.trim()),
      ).toEqual(["cards"]);
    });
    expect(screen.queryByTestId(BANNER)).not.toBeInTheDocument();
  });

  it("renders every declared toolset id as its own chip", async () => {
    stubBindings([
      binding({ toolsets: ["cards", "notes"], uncovered_toolsets: [] }),
    ]);
    renderDialog();

    await findSkillRow(/release checklist/i);
    await waitFor(() => {
      expect(
        screen.getAllByTestId(CHIP).map((chip) => chip.textContent?.trim()),
      ).toEqual(["cards", "notes"]);
    });
  });

  it("renders the uncovered banner naming the ids the loop grant cannot cover", async () => {
    stubBindings([
      binding({ toolsets: ["cards"], uncovered_toolsets: ["cards"] }),
    ]);
    renderDialog();

    await findSkillRow(/release checklist/i);
    const banner = await screen.findByTestId(BANNER);
    expect(banner).toHaveTextContent("cards");
    expect(banner).toHaveTextContent(bannerCopyPrefix());
    // The chips still render alongside the banner — the banner adds, never
    // replaces, the declared hand.
    expect(screen.getAllByTestId(CHIP)).toHaveLength(1);
  });

  it("lists only the uncovered ids in the banner when the hand is partially covered", async () => {
    stubBindings([
      binding({
        toolsets: ["cards", "notes", "approvals"],
        uncovered_toolsets: ["approvals"],
      }),
    ]);
    renderDialog();

    await findSkillRow(/release checklist/i);
    const banner = await screen.findByTestId(BANNER);
    expect(banner).toHaveTextContent("approvals");
    expect(banner).not.toHaveTextContent(/\bnotes\b/);
  });
});
