// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import type { CollectionViewControls } from "@/components/collection";
import type { Card } from "@/types/kanban";
import { BoardFilterBar } from "../BoardFilterBar";

function makeControls(
  overrides: Partial<CollectionViewControls<Card>> = {},
): CollectionViewControls<Card> {
  return {
    search: "",
    setSearch: vi.fn(),
    sortId: "manual",
    setSortId: vi.fn(),
    sortDirection: "asc",
    setSortDirection: vi.fn(),
    toggleSortDirection: vi.fn(),
    filterValues: {},
    setFilterValue: vi.fn(),
    resetFilters: vi.fn(),
    sorters: [],
    filters: [],
    activeFilterCount: 0,
    ...overrides,
  };
}

function renderBar(controls = makeControls()) {
  return renderWithProviders(
    <BoardFilterBar
      controls={controls}
      visibleCount={5}
      totalCount={8}
      labelOptions={["backend"]}
      assigneeOptions={[{ value: "u1", label: "Ana" }]}
      viewMode="grid"
      onViewModeChange={() => {}}
    />,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("BoardFilterBar — collapsed by default, expandable on demand", () => {
  it("starts collapsed: search/sort/filter chips hidden, toggle + count + view switcher visible", () => {
    renderBar();
    const toggle = screen.getByRole("button", { name: /filters/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByPlaceholderText(/search cards/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/manual order/i)).not.toBeInTheDocument();
    // The essentials survive collapse: result count + view-mode switcher.
    expect(screen.getByText("5 of 8")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /view mode/i }),
    ).toBeInTheDocument();
  });

  it("expanding reveals search, sort, and the filter chips", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: /filters/i }));
    expect(
      screen.getByRole("button", { name: /filters/i }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByPlaceholderText(/search cards/i)).toBeInTheDocument();
    expect(screen.getByText(/manual order/i)).toBeInTheDocument();
    expect(screen.getByText(/runner activity/i)).toBeInTheDocument();
  });

  it("remembers the expanded choice across mounts", async () => {
    const user = userEvent.setup();
    const first = renderBar();
    await user.click(screen.getByRole("button", { name: /filters/i }));
    first.unmount();

    renderBar();
    expect(
      screen.getByRole("button", { name: /filters/i }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByPlaceholderText(/search cards/i)).toBeInTheDocument();
  });

  it("shows how many controls are active while collapsed, so hidden filters can't silently eat cards", () => {
    renderBar(makeControls({ activeFilterCount: 2, search: "auth" }));
    // 2 filters + 1 search = 3 active controls narrowing the board.
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
