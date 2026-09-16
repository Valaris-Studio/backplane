// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import type { ActivityEntityType } from "@/types/activity";
import { ActivityTypeFilter } from "../ActivityTypeFilter";

const PRESENT: ActivityEntityType[] = ["card", "note", "board"];

describe("ActivityTypeFilter", () => {
  it("renders one chip per entity type present in the feed, plus an all chip", () => {
    const { container } = renderWithProviders(
      <ActivityTypeFilter
        entityTypes={PRESENT}
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    // Chips are derived from the feed rather than from the full entity-type
    // enum, so no chip can ever filter the list down to nothing.
    expect(
      container.querySelectorAll("[data-activity-type-chip]"),
    ).toHaveLength(PRESENT.length + 1);
  });

  it("reports the clicked entity type to the caller", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(
      <ActivityTypeFilter
        entityTypes={PRESENT}
        selected={null}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTestId("activity-type-chip-note"));

    expect(onSelect).toHaveBeenCalledWith("note");
  });

  it("clears the selection when the all chip is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(
      <ActivityTypeFilter
        entityTypes={PRESENT}
        selected="note"
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTestId("activity-type-chip-all"));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("deselects when the already-selected chip is clicked again", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderWithProviders(
      <ActivityTypeFilter
        entityTypes={PRESENT}
        selected="note"
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByTestId("activity-type-chip-note"));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks only the selected chip as pressed", () => {
    renderWithProviders(
      <ActivityTypeFilter
        entityTypes={PRESENT}
        selected="card"
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId("activity-type-chip-card")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("activity-type-chip-all")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("renders nothing when the feed holds a single entity type — a filter with one option filters nothing", () => {
    const { container } = renderWithProviders(
      <ActivityTypeFilter
        entityTypes={["card"]}
        selected={null}
        onSelect={vi.fn()}
      />,
    );

    expect(container.querySelector("[data-activity-type-chip]")).toBeNull();
  });
});
