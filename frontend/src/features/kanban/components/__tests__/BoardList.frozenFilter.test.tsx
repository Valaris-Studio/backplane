// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { Board } from "@/types/kanban";

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useParams: () => ({ slug: "acme" }) };
});

vi.mock("@/features/visuals/components/WaveBackground", () => ({
  __esModule: true,
  WaveBackground: () => <div data-testid="wave-bg" />,
}));

function makeBoard(overrides: Partial<Board> & { name: string }): Board {
  return {
    id: overrides.name.toLowerCase(),
    slug: overrides.name.toLowerCase(),
    description: "",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    card_count: 0,
    column_count: 0,
    last_activity_at: null,
    ...overrides,
  };
}

// `boards` is reassigned per test so a single module-level mock can serve both
// the mixed-list and all-frozen scenarios.
let boards: Board[] = [];

vi.mock("../../api/use-boards", () => ({
  useBoards: () => ({ data: boards, isLoading: false }),
  useCreateBoard: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { BoardList } from "../BoardList";

const ACTIVE = makeBoard({ name: "Alpha", description: "Payments work" });
const FROZEN = makeBoard({ name: "Zulu", is_frozen: true });

function visibleBoardNames(): string[] {
  return screen
    .queryAllByText(/^(Alpha|Zulu)$/)
    .map((el) => el.textContent ?? "");
}

function toggleButton(name: RegExp) {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  window.localStorage.clear();
  boards = [ACTIVE, FROZEN];
});

describe("BoardList — frozen board visibility toggle", () => {
  it("shows frozen boards by default and offers to hide them", () => {
    renderWithProviders(<BoardList />);
    expect(visibleBoardNames().sort()).toEqual(["Alpha", "Zulu"]);

    const toggle = toggleButton(/hide frozen boards/i);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("hides frozen boards on click and flips the button's label and pressed state", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    await user.click(toggleButton(/hide frozen boards/i));

    expect(visibleBoardNames()).toEqual(["Alpha"]);
    const toggle = toggleButton(/show frozen boards/i);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("persists the hidden choice to localStorage and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<BoardList />);
    await user.click(toggleButton(/hide frozen boards/i));
    expect(window.localStorage.getItem("valaris.boardShowFrozen")).toBe("false");
    unmount();

    renderWithProviders(<BoardList />);
    expect(visibleBoardNames()).toEqual(["Alpha"]);
    expect(toggleButton(/show frozen boards/i)).toBeInTheDocument();
  });

  it("composes with the search filter", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);
    await user.click(toggleButton(/hide frozen boards/i));

    await user.type(screen.getByRole("textbox", { name: /search/i }), "payments");
    expect(visibleBoardNames()).toEqual(["Alpha"]);
  });

  it("stays visible even when the workspace has no frozen boards", () => {
    boards = [ACTIVE];
    renderWithProviders(<BoardList />);
    expect(toggleButton(/hide frozen boards/i)).toBeInTheDocument();
  });
});

describe("BoardList — all-boards-frozen empty state", () => {
  beforeEach(() => {
    boards = [FROZEN];
  });

  it("shows a dedicated empty state, not the search no-match one", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);
    await user.click(toggleButton(/hide frozen boards/i));

    expect(screen.getByText(/all boards here are frozen/i)).toBeInTheDocument();
    expect(screen.queryByText(/no boards match/i)).not.toBeInTheDocument();
  });

  it("restores frozen visibility from the empty state's action", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);
    await user.click(toggleButton(/hide frozen boards/i));

    // Two controls share the "Show frozen boards" name once the empty state is
    // up (the header toggle and the empty-state action) — click the latter.
    const restore = screen
      .getAllByRole("button", { name: /show frozen boards/i })
      .at(-1)!;
    await user.click(restore);

    expect(visibleBoardNames()).toEqual(["Zulu"]);
  });

  it("keeps the search no-match state when a query is active", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);
    await user.click(toggleButton(/hide frozen boards/i));
    await user.type(screen.getByRole("textbox", { name: /search/i }), "nothing");

    expect(screen.getByText(/no boards match/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/all boards here are frozen/i),
    ).not.toBeInTheDocument();
  });
});
