// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  renderWithProviders,
  screen,
  waitFor,
  within,
  userEvent,
} from "@/test/test-utils";
import { server, http, HttpResponse } from "@/test/msw-server";

// Owner visual validation (2026-08-04) produced three contracts on the step
// CARD. The rail refactor replaced the cards with pills, so the two that are
// about meaning rather than card geometry carry over here:
// - the done state is UNMISTAKABLE — a green check that stays green in both
//   themes, and each state is visually distinct from the others;
// - exactly one status marker per step, so the celebration can never tween a
//   stale node.
// The third (an icon tile straddling the card edge, skip folded inline beside
// the toggle) died with the card: a pill carries no controls and no overhang.
// Nested-button safety is re-pinned on the modal, where skip now lives.
import { OnboardingChecklist } from "../OnboardingChecklist";

const SLUG = "acme";

const STEP_IDS = ["board", "context", "notes", "members", "channels", "repos"];

const boardAlpha = {
  id: "b1",
  slug: "alpha",
  name: "Alpha",
  description: "",
  tags: [],
  workspace_id: "ws-1",
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

const soloMember = {
  id: "m1",
  user_id: "u1",
  email: "owner@acme.dev",
  role: "owner",
  created_at: "2026-07-31T00:00:00Z",
};

const definitionFixture = {
  id: "def-1",
  board_id: "b1",
  scope: "board",
  content: { objectives: [{ text: "Ship the first release", priority: null }] },
  created_at: "2026-07-31T00:00:00Z",
  updated_at: "2026-07-31T00:00:00Z",
};

interface WorkspaceState {
  boardCount?: number;
  channelCount?: number;
  boards?: unknown[];
  hasDefinition?: boolean;
}

function installWorkspaceHandlers(state: WorkspaceState = {}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: state.boardCount ?? 0,
        card_count: 0,
        note_count: 0,
        channel_count: state.channelCount ?? 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json(state.boards ?? []),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json([soloMember]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      state.hasDefinition
        ? HttpResponse.json(definitionFixture)
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json([]),
    ),
    http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
  );
}

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  window.localStorage.clear();
  stubMatchMedia(true);
});

afterEach(() => stubMatchMedia(false));

function renderChecklist() {
  return renderWithProviders(<OnboardingChecklist slug={SLUG} />);
}

function stepEl(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(
    `[data-onboarding-step="${id}"]`,
  )!;
}

function statusIcon(step: HTMLElement) {
  return step.querySelector<SVGElement>("[data-step-status-icon]")!;
}

function modalEl() {
  return document.querySelector<HTMLElement>("[data-onboarding-modal]")!;
}

// Skip now runs through the step's modal — open the pill, skip, let it close.
async function skipStep(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  id: string,
) {
  const step = stepEl(container, id);
  await user.click(within(step).getByRole("button"));
  await user.click(
    within(modalEl()).getByText(
      id === "members" ? "Working solo for now" : "Skip",
    ),
  );
  await waitFor(() =>
    expect(step.getAttribute("data-step-state")).toBe("skipped"),
  );
}

// A workspace with a board, a definition and a channel — three steps land done
// while the rest stay empty, so every state is on screen at once.
function installMixedWorkspace() {
  installWorkspaceHandlers({
    boardCount: 1,
    channelCount: 1,
    boards: [boardAlpha],
    hasDefinition: true,
  });
}

describe("OnboardingChecklist — unmistakable done state", () => {
  it("marks a done step with a green check that is theme-independent", async () => {
    installMixedWorkspace();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const boardStep = stepEl(container, "board");
    await waitFor(() =>
      expect(boardStep.getAttribute("data-step-state")).toBe("done"),
    );

    const iconClass = statusIcon(boardStep).getAttribute("class")!;
    // --color-success-foreground is a foreground-ON-TINTED-BG pairing token:
    // near-black green in light mode, so it rendered gray on the untinted
    // pill. --color-success is the standalone-glyph green and is NOT
    // overridden per theme, so it stays green in light AND dark.
    expect(iconClass).toContain("var(--color-success)");
    expect(iconClass).not.toContain("success-foreground");
  });

  it("mounts exactly one status marker per step, in every state", async () => {
    installMixedWorkspace();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await waitFor(() =>
      expect(stepEl(container, "board").getAttribute("data-step-state")).toBe(
        "done",
      ),
    );
    await skipStep(user, container, "notes");

    // Two markers would mean two elements racing for statusIconRef, and the
    // celebration could tween the unmounted one.
    for (const id of STEP_IDS) {
      expect(
        stepEl(container, id).querySelectorAll("[data-step-status-icon]"),
        `step "${id}" has more than one status marker`,
      ).toHaveLength(1);
    }
  });

  it("names the done state in words inside the step's modal, only when done", async () => {
    installMixedWorkspace();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const boardStep = stepEl(container, "board");
    await waitFor(() =>
      expect(boardStep.getAttribute("data-step-state")).toBe("done"),
    );

    // The pill has no room for a word, so "Done" lives in the modal header.
    await user.click(within(boardStep).getByRole("button"));
    expect(within(modalEl()).getByText("Done")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(modalEl()).toBeNull());

    // Pending steps carry no done label — the word must mean one thing.
    await user.click(within(stepEl(container, "notes")).getByRole("button"));
    expect(within(modalEl()).queryByText("Done")).toBeNull();
  });

  it("tints the done pill with success, keeps skipped muted and empty inviting", async () => {
    installMixedWorkspace();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const boardStep = stepEl(container, "board");
    await waitFor(() =>
      expect(boardStep.getAttribute("data-step-state")).toBe("done"),
    );
    await skipStep(user, container, "notes");

    const pillClass = (id: string) =>
      within(stepEl(container, id)).getByRole("button").className;
    const doneClass = pillClass("board");
    const skippedClass = pillClass("notes");
    const emptyClass = pillClass("members");

    // Done reads as success, not as "another gray pill".
    expect(doneClass).toContain("success");
    expect(skippedClass).not.toContain("success");
    expect(emptyClass).not.toContain("success");

    // Skipped stays deliberately quiet; empty stays the inviting primary tint
    // (members is the first unresolved step here, so it also reads as active).
    expect(skippedClass).toContain("muted");
    expect(emptyClass).toContain("primary");

    // The three states are visually distinct from one another.
    expect(new Set([doneClass, skippedClass, emptyClass]).size).toBe(3);
  });
});

describe("OnboardingChecklist — the rail pill carries no nested controls", () => {
  it("keeps every pill a single button with no button nested inside it", async () => {
    installWorkspaceHandlers();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });

    for (const id of STEP_IDS) {
      const step = stepEl(container, id);
      // One control per step: the pill itself. Skip/revisit moved to the
      // modal, so the old "skip nested in the toggle" hazard cannot recur.
      expect(
        within(step).getAllByRole("button"),
        `step "${id}" has more than one control`,
      ).toHaveLength(1);
      expect(
        step.querySelectorAll("button button").length,
        `step "${id}" has a nested button`,
      ).toBe(0);
      expect(within(step).queryByText("Skip")).toBeNull();
    }
  });

  it("swaps skip for revisit in the modal once a step is skipped", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const step = stepEl(container, "channels");

    await user.click(within(step).getByRole("button"));
    expect(within(modalEl()).getByText("Skip")).toBeInTheDocument();
    expect(within(modalEl()).queryByText("Revisit")).toBeNull();
    await user.click(within(modalEl()).getByText("Skip"));
    await waitFor(() =>
      expect(step.getAttribute("data-step-state")).toBe("skipped"),
    );

    await user.click(within(step).getByRole("button"));
    expect(within(modalEl()).getByText("Revisit")).toBeInTheDocument();
    expect(within(modalEl()).queryByText("Skip")).toBeNull();
    expect(modalEl().querySelectorAll("button button")).toHaveLength(0);
  });
});
