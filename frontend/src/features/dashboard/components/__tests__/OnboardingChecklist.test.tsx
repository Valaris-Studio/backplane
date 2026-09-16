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

// Stage-A contract for the guided setup checklist (spec card 75b94de2):
// - <OnboardingChecklist slug /> replaces FirstRunPanel on the dashboard.
//   State is ALWAYS derived from real workspace data fetched over the wire
//   (summary/boards/members/definitions/git-repos) — never a stored cursor.
// - DOM contract: panel root carries `data-onboarding-checklist`; each of the
//   six areas is a `[data-onboarding-step="<id>"]` element with
//   `data-step-state="empty"|"done"|"skipped"`, ids: board, context, notes,
//   members, channels, repos. The runner footer carries
//   `data-onboarding-footer` and is NOT a step (no data-step-state).
// - Step cards start closed; clicking a card's headline opens its mini-form in
//   a portaled modal (rail refactor — content used to render inline in a
//   step card). Per-area skip persists per workspace; whole-panel dismiss uses
//   `valaris:onboardingChecklist:dismissed:<slug>` = "1" (FirstRunPanel
//   mechanics); `valaris:onboardingChecklist:collapsed:<slug>` = "1" keeps
//   the whole panel collapsed-but-available.
import { OnboardingChecklist } from "../OnboardingChecklist";

const SLUG = "acme";
const DISMISS_KEY = `valaris:onboardingChecklist:dismissed:${SLUG}`;
const COLLAPSED_KEY = `valaris:onboardingChecklist:collapsed:${SLUG}`;

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

const seededColumns = [
  { id: "col-todo", name: "To Do", column_type: "backlog", position: 1024, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
  { id: "col-active", name: "In Progress", column_type: "active", position: 2048, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
  { id: "col-blocked", name: "Blocked", column_type: "blocked", position: 3072, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
  { id: "col-done", name: "Done", column_type: "done", position: 4096, board_id: "b1", cards: [], created_at: "2026-07-31T00:00:00Z", updated_at: "2026-07-31T00:00:00Z" },
];

const soloMember = {
  id: "m1",
  user_id: "u1",
  email: "owner@acme.dev",
  role: "owner",
  created_at: "2026-07-31T00:00:00Z",
};

const secondMember = {
  id: "m2",
  user_id: "u2",
  email: "teammate@acme.dev",
  role: "member",
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
  noteCount?: number;
  channelCount?: number;
  boards?: unknown[];
  members?: unknown[];
  hasDefinition?: boolean;
  repos?: unknown[];
}

function installWorkspaceHandlers(state: WorkspaceState = {}) {
  server.use(
    http.get(`/api/workspaces/${SLUG}/summary`, () =>
      HttpResponse.json({
        board_count: state.boardCount ?? 0,
        card_count: 0,
        note_count: state.noteCount ?? 0,
        channel_count: state.channelCount ?? 0,
        recent_activity: [],
      }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards`, () =>
      HttpResponse.json(state.boards ?? []),
    ),
    http.get(`/api/workspaces/${SLUG}/members`, () =>
      HttpResponse.json(state.members ?? [soloMember]),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
      state.hasDefinition
        ? HttpResponse.json(definitionFixture)
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
      HttpResponse.json(state.repos ?? []),
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
  // Reduced motion so gsap entrances/celebrations never hide content from
  // queries — the celebration itself is pinned by the stage-B test.
  stubMatchMedia(true);
});

afterEach(() => stubMatchMedia(false));

function renderChecklist() {
  return renderWithProviders(<OnboardingChecklist slug={SLUG} />);
}

function stepEl(container: HTMLElement, id: string) {
  return container.querySelector<HTMLElement>(`[data-onboarding-step="${id}"]`);
}

describe("OnboardingChecklist — six areas derived from real workspace data", () => {
  it("renders all six setup areas as empty for a fresh workspace", async () => {
    installWorkspaceHandlers();
    const { container } = renderChecklist();

    // The rail names each area with a short pill label; the long titles live
    // in the modal each pill opens.
    expect(
      await screen.findByRole("button", { name: /Board/ }),
    ).toBeInTheDocument();
    for (const label of ["Definition", "Notes", "Team", "Channel", "Git"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }

    for (const id of STEP_IDS) {
      const row = stepEl(container, id);
      expect(row, `missing step row "${id}"`).not.toBeNull();
      expect(row!.getAttribute("data-step-state")).toBe("empty");
    }
  });

  it("derives done-states from workspace data, not stored progress", async () => {
    installWorkspaceHandlers({
      boardCount: 1,
      channelCount: 1,
      boards: [boardAlpha],
      hasDefinition: true,
      members: [soloMember],
    });
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    await waitFor(() => {
      expect(stepEl(container, "board")!.getAttribute("data-step-state")).toBe("done");
      expect(stepEl(container, "context")!.getAttribute("data-step-state")).toBe("done");
      expect(stepEl(container, "channels")!.getAttribute("data-step-state")).toBe("done");
    });
    expect(stepEl(container, "notes")!.getAttribute("data-step-state")).toBe("empty");
    expect(stepEl(container, "members")!.getAttribute("data-step-state")).toBe("empty");
    expect(stepEl(container, "repos")!.getAttribute("data-step-state")).toBe("empty");
  });
});

describe("OnboardingChecklist — runner footer", () => {
  it("shows the runner footer as a non-step with an experimental badge and docs link", async () => {
    installWorkspaceHandlers();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });

    const footer = container.querySelector<HTMLElement>("[data-onboarding-footer]");
    expect(footer).not.toBeNull();
    expect(within(footer!).getByText("Runners")).toBeInTheDocument();
    expect(within(footer!).getByText("experimental")).toBeInTheDocument();
    expect(
      within(footer!).getByText(/Autonomous agents that pick up cards and write code/),
    ).toBeInTheDocument();

    // Links to the in-app runner documentation — nowhere else in the panel.
    const docsLink = within(footer!).getByRole("link");
    expect(docsLink.getAttribute("href")).toBe(
      `/${SLUG}/documentation/registering-a-runner`,
    );

    // The footer is NOT a step: exactly six step rows, none of them the
    // footer, and the footer never carries a done/empty/skipped state.
    expect(container.querySelectorAll("[data-onboarding-step]")).toHaveLength(6);
    expect(footer!.hasAttribute("data-onboarding-step")).toBe(false);
    expect(footer!.hasAttribute("data-step-state")).toBe(false);
  });
});

describe("OnboardingChecklist — per-area skip", () => {
  it("skips the members area via 'Working solo for now', collapses it muted with a revisit affordance, and persists", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container, unmount } = renderChecklist();

    await screen.findByRole("button", { name: /Team/ });
    const membersRow = stepEl(container, "members")!;
    // Skip lives in the step's modal now — the rail pill carries no controls.
    await user.click(within(membersRow).getByRole("button"));
    const modal = document.querySelector<HTMLElement>("[data-onboarding-modal]")!;
    await user.click(within(modal).getByText("Working solo for now"));

    await waitFor(() =>
      expect(membersRow.getAttribute("data-step-state")).toBe("skipped"),
    );
    // Reopening the skipped step offers the way back.
    await user.click(within(membersRow).getByRole("button"));
    expect(
      within(
        document.querySelector<HTMLElement>("[data-onboarding-modal]")!,
      ).getByText("Revisit"),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Skip state is per-workspace localStorage — it survives a remount.
    unmount();
    const remounted = renderChecklist();
    await screen.findByRole("button", { name: /Team/ });
    await waitFor(() =>
      expect(
        stepEl(remounted.container, "members")!.getAttribute("data-step-state"),
      ).toBe("skipped"),
    );
  });

  it("skips any area via its Skip link and reopens it via Revisit", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Channel/ });
    const channelsRow = stepEl(container, "channels")!;
    const modal = () =>
      document.querySelector<HTMLElement>("[data-onboarding-modal]")!;

    await user.click(within(channelsRow).getByRole("button"));
    await user.click(within(modal()).getByText("Skip"));
    await waitFor(() =>
      expect(channelsRow.getAttribute("data-step-state")).toBe("skipped"),
    );

    await user.click(within(channelsRow).getByRole("button"));
    await user.click(within(modal()).getByText("Revisit"));
    await waitFor(() =>
      expect(channelsRow.getAttribute("data-step-state")).toBe("empty"),
    );
  });
});

describe("OnboardingChecklist — whole-panel dismiss and collapse", () => {
  it("dismisses the whole panel persistently, FirstRunPanel-style", async () => {
    installWorkspaceHandlers();
    const user = userEvent.setup();
    const { container, unmount } = renderChecklist();

    await screen.findByText("Make this workspace yours");
    await user.click(
      screen.getByRole("button", { name: "Dismiss the setup guide" }),
    );

    await waitFor(() =>
      expect(container.querySelector("[data-onboarding-checklist]")).toBeNull(),
    );
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe("1");

    unmount();
    const remounted = renderChecklist();
    expect(
      remounted.container.querySelector("[data-onboarding-checklist]"),
    ).toBeNull();
    expect(screen.queryByText("Make this workspace yours")).toBeNull();
  });

  it("stays collapsed-but-available when the collapsed flag is set, and expands on demand", async () => {
    window.localStorage.setItem(COLLAPSED_KEY, "1");
    installWorkspaceHandlers();
    const user = userEvent.setup();
    renderChecklist();

    expect(
      await screen.findByText("Make this workspace yours"),
    ).toBeInTheDocument();
    // Collapsed shows the title alone — the rail and its pills stay hidden.
    expect(screen.queryByRole("button", { name: /Board/ })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Open the setup guide" }),
    );
    expect(
      await screen.findByRole("button", { name: /Board/ }),
    ).toBeInTheDocument();
  });
});

describe("OnboardingChecklist — board mini-form in the step popover", () => {
  it("creates the board without client-side column POSTs, then offers card inputs", async () => {
    let boardCreated = false;
    let boardPosts = 0;
    let columnPosts = 0;
    server.use(
      http.get(`/api/workspaces/${SLUG}/summary`, () =>
        HttpResponse.json({
          board_count: boardCreated ? 1 : 0,
          card_count: 0,
          note_count: 0,
          channel_count: 0,
          recent_activity: [],
        }),
      ),
      http.get(`/api/workspaces/${SLUG}/boards`, () =>
        HttpResponse.json(boardCreated ? [boardAlpha] : []),
      ),
      http.get(`/api/workspaces/${SLUG}/members`, () =>
        HttpResponse.json([soloMember]),
      ),
      http.get(`/api/workspaces/${SLUG}/boards/:boardId/definitions`, () =>
        HttpResponse.json({ detail: "Not found" }, { status: 404 }),
      ),
      http.get(`/api/workspaces/${SLUG}/boards/:boardId/git-repos`, () =>
        HttpResponse.json([]),
      ),
      http.get(`/api/workspaces/${SLUG}/resources`, () => HttpResponse.json([])),
      http.post(`/api/workspaces/${SLUG}/boards`, () => {
        boardPosts += 1;
        boardCreated = true;
        // Backend returns BoardDetailRead with the auto-seeded typed columns.
        return HttpResponse.json(
          { ...boardAlpha, columns: seededColumns },
          { status: 201 },
        );
      }),
      // The backend seeds To Do/In Progress/Blocked/Done itself; the wizard
      // must never hit this.
      http.post(`/api/workspaces/${SLUG}/boards/:boardId/columns`, () => {
        columnPosts += 1;
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    const user = userEvent.setup();
    const { container } = renderChecklist();

    await screen.findByRole("button", { name: /Board/ });
    const boardCard = stepEl(container, "board")!;
    // Cards open a mini-form in a popover — the user never leaves the wizard.
    await user.click(within(boardCard).getByRole("button"));

    const panel = document.querySelector<HTMLElement>(
      "[data-onboarding-modal]",
    )!;
    await user.type(
      within(panel).getByPlaceholderText("Board name"),
      "Alpha",
    );
    await user.click(
      within(panel).getByRole("button", { name: "Create board" }),
    );

    await waitFor(() => expect(boardPosts).toBe(1));
    expect(columnPosts).toBe(0);

    // With the board created, the optional card inputs appear in the popover.
    expect(
      await within(panel).findByText("What's on your plate right now?"),
    ).toBeInTheDocument();
  });
});

describe("OnboardingChecklist — all-done state", () => {
  it("links the all-done CTA to the first board, never the runner overview", async () => {
    installWorkspaceHandlers({
      boardCount: 1,
      noteCount: 1,
      channelCount: 1,
      boards: [boardAlpha],
      members: [soloMember, secondMember],
      hasDefinition: true,
      repos: [
        {
          id: "repo-1",
          name: "alpha",
          url: "https://github.com/acme/alpha",
          provider: "github",
        },
      ],
    });
    const { container } = renderChecklist();

    expect(
      await screen.findByText("Your workspace is ready"),
    ).toBeInTheDocument();

    const cta = screen.getByRole("link", { name: /Open your board/ });
    expect(cta.getAttribute("href")).toBe(`/${SLUG}/boards/alpha`);

    expect(
      container.querySelectorAll('a[href*="runner/overview"]'),
    ).toHaveLength(0);
  });
});
