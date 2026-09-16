// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test/test-utils";
import { DependencyValidationPanel } from "../DependencyValidationPanel";
import type { BoardDependencyValidation } from "@/types/kanban";

const ok: BoardDependencyValidation = {
  ok: true,
  cycles: [],
  conflicts: [],
  orphans: [],
};

describe("DependencyValidationPanel", () => {
  it("renders a healthy state when there are no issues", () => {
    renderWithProviders(<DependencyValidationPanel validation={ok} />);
    expect(screen.getByText(/no dependency issues/i)).toBeInTheDocument();
  });

  it("renders nothing while loading with no data", () => {
    const { container } = renderWithProviders(
      <DependencyValidationPanel validation={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("groups cycles, conflicts and orphans with their summaries", () => {
    const validation: BoardDependencyValidation = {
      ok: false,
      cycles: [{ card_ids: ["a", "b"], titles: ["A", "B"], summary: "A depends on B which depends on A" }],
      conflicts: [
        {
          card_id: "c",
          title: "C",
          unsatisfied_dependency_ids: ["d"],
          unsatisfied_dependency_titles: ["D"],
          summary: "C is ready but depends on unfinished D",
        },
      ],
      orphans: [
        {
          card_id: "e",
          depends_on_card_id: "ghost",
          card_on_board: true,
          depends_on_on_board: false,
          summary: "E depends on a card not on this board",
        },
      ],
    };

    renderWithProviders(<DependencyValidationPanel validation={validation} />);

    expect(screen.getByText("A depends on B which depends on A")).toBeInTheDocument();
    expect(screen.getByText("C is ready but depends on unfinished D")).toBeInTheDocument();
    expect(screen.getByText("E depends on a card not on this board")).toBeInTheDocument();
  });

  it("uses singular plural form for a single cycle", () => {
    const validation: BoardDependencyValidation = {
      ok: false,
      cycles: [{ card_ids: ["a", "b"], titles: ["A", "B"], summary: "loop" }],
      conflicts: [],
      orphans: [],
    };
    renderWithProviders(<DependencyValidationPanel validation={validation} />);
    expect(screen.getByText(/1 cycle\b/i)).toBeInTheDocument();
  });

  it("uses plural form for multiple conflicts", () => {
    const validation: BoardDependencyValidation = {
      ok: false,
      cycles: [],
      conflicts: [
        { card_id: "a", title: "A", unsatisfied_dependency_ids: [], unsatisfied_dependency_titles: [], summary: "x" },
        { card_id: "b", title: "B", unsatisfied_dependency_ids: [], unsatisfied_dependency_titles: [], summary: "y" },
      ],
      orphans: [],
    };
    renderWithProviders(<DependencyValidationPanel validation={validation} />);
    expect(screen.getByText(/2 conflicts/i)).toBeInTheDocument();
  });

  it("invokes onFocusCard when a cycle item is clicked", async () => {
    const onFocusCard = vi.fn();
    const validation: BoardDependencyValidation = {
      ok: false,
      cycles: [{ card_ids: ["a", "b"], titles: ["A", "B"], summary: "loop" }],
      conflicts: [],
      orphans: [],
    };
    const user = userEvent.setup();
    renderWithProviders(
      <DependencyValidationPanel validation={validation} onFocusCard={onFocusCard} />,
    );

    await user.click(screen.getByText("loop"));
    expect(onFocusCard).toHaveBeenCalledWith("a");
  });
});
