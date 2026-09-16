// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import type { CollectionViewControls, ViewMode } from "@/components/collection";
import type { Card } from "@/types/kanban";
import { BoardFilterBar } from "../BoardFilterBar";

function makeControls(): CollectionViewControls<Card> {
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
  };
}

function renderBar(viewMode: ViewMode, onViewModeChange = vi.fn()) {
  renderWithProviders(
    <BoardFilterBar
      controls={makeControls()}
      visibleCount={5}
      totalCount={8}
      labelOptions={[]}
      assigneeOptions={[]}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
    />,
  );
  return onViewModeChange;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("BoardFilterBar — Board / Compact / Table segmented control", () => {
  it("offers exactly three segments in grid → compact → list order", () => {
    renderBar("grid");
    const group = screen.getByRole("group", { name: /view mode/i });
    const segments = within(group).getAllByRole("button");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toHaveAttribute("aria-label", "Board view");
    expect(segments[1]).toHaveAttribute("aria-label", "Compact view");
    expect(segments[2]).toHaveAttribute("aria-label", "Table view");
  });

  it("selects compact and reports it as pressed", async () => {
    const user = userEvent.setup();
    const onViewModeChange = renderBar("grid");
    await user.click(screen.getByRole("button", { name: "Compact view" }));
    expect(onViewModeChange).toHaveBeenCalledWith("compact");
  });

  it("marks only the active segment as pressed while in compact mode", () => {
    renderBar("compact");
    expect(screen.getByRole("button", { name: "Compact view" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Board view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "Table view" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
