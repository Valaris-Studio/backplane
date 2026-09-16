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

const boards: Board[] = [
  {
    id: "b-1",
    slug: "alpha",
    name: "Alpha",
    description: "Payments work",
    tags: ["payments"],
    workspace_id: "ws-1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    card_count: 2,
    column_count: 3,
    last_activity_at: "2026-02-01T00:00:00Z",
  },
  {
    id: "b-2",
    slug: "zulu",
    name: "Zulu",
    description: "Infra hardening",
    tags: [],
    workspace_id: "ws-1",
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    card_count: 40,
    column_count: 5,
    last_activity_at: "2026-07-01T00:00:00Z",
  },
];

vi.mock("../../api/use-boards", () => ({
  useBoards: () => ({ data: boards, isLoading: false }),
  // CreateBoardDialog (rendered closed) still calls the mutation hook.
  useCreateBoard: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { BoardList } from "../BoardList";

// Text queries, not roles: the grid's GSAP entrance sets visibility:hidden
// mid-animation, which drops link roles OUT of the a11y tree in jsdom.
function boardNamesInOrder(): string[] {
  return screen
    .getAllByText(/^(Alpha|Zulu)$/)
    .map((el) => el.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("BoardList — search and sort controls", () => {
  it("orders by activity (most recent first) by default", () => {
    renderWithProviders(<BoardList />);
    expect(boardNamesInOrder()).toEqual(["Zulu", "Alpha"]);
  });

  it("filters boards by name, description, or tag", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);
    const search = screen.getByRole("textbox", { name: /search/i });

    await user.type(search, "payments");
    expect(boardNamesInOrder()).toEqual(["Alpha"]);

    await user.clear(search);
    await user.type(search, "infra");
    expect(boardNamesInOrder()).toEqual(["Zulu"]);
  });

  it("re-orders when sorting by name", async () => {
    const user = userEvent.setup();
    renderWithProviders(<BoardList />);

    await user.click(screen.getByRole("button", { name: /sort boards/i }));
    await user.click(await screen.findByRole("menuitemradio", { name: /name/i }));
    expect(boardNamesInOrder()).toEqual(["Alpha", "Zulu"]);
  });
});
