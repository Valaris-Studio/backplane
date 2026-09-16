// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test/test-utils";
import { ReplayCardDense } from "../ReplayCardDense";
import type { CardSnapshot, FrameCard } from "../../types";

function card(overrides: Partial<CardSnapshot> = {}, legacy = false): FrameCard {
  return {
    snapshot: {
      id: "card1",
      title: "Keep the complete card title available",
      card_type: "bug",
      priority: "high",
      column_id: "col1",
      position: 1024,
      status: null,
      labels: null,
      participants: [{ user_id: "u1", agent_id: null, name: "Alice Doe", role: "custom-reviewer", avatar_url: null }],
      ...overrides,
    },
    legacy,
  };
}

function setup(frameCard = card(), props: Partial<Parameters<typeof ReplayCardDense>[0]> = {}) {
  const onClick = vi.fn();
  const view = renderWithProviders(
    <ReplayCardDense card={frameCard} selected={false} onClick={onClick} reducedMotion {...props} />,
  );
  return { ...view, onClick };
}

describe("ReplayCardDense", () => {
  it("renders a small colored square with no visible title while retaining its accessible identity", () => {
    setup();
    const tile = screen.getByRole("button", { name: "Keep the complete card title available" });
    expect(tile).toHaveClass("h-9", "w-9");
    expect(tile).toHaveAttribute("data-replay-card", "card1");
    expect(tile).toHaveAttribute("aria-pressed", "false");
    expect(tile).toHaveAccessibleDescription(/Bug · High · Alice Doe/);
    expect(screen.queryByText("Keep the complete card title available")).toBeNull();
    expect(tile.style.backgroundColor).toContain("--color-destructive");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each(["hover", "focus"])("reveals the complete snapshot on %s", async (interaction) => {
    const user = userEvent.setup();
    setup(card({ status: "investigating", labels: ["auth", "blocked-by-api"] }));
    const tile = screen.getByRole("button", { name: "Keep the complete card title available" });
    if (interaction === "hover") await user.hover(tile);
    else await user.tab();
    const tooltip = screen.getByRole("tooltip");
    expect(within(tooltip).getByText("Keep the complete card title available")).toBeInTheDocument();
    expect(within(tooltip).getByText("Bug")).toBeInTheDocument();
    expect(within(tooltip).getByText("High")).toBeInTheDocument();
    expect(within(tooltip).getByText("investigating")).toBeInTheDocument();
    expect(within(tooltip).getByText("Alice Doe")).toBeInTheDocument();
    expect(within(tooltip).getByText("custom reviewer")).toBeInTheDocument();
    expect(within(tooltip).getByText("auth")).toBeInTheDocument();
    expect(within(tooltip).getByText("blocked-by-api")).toBeInTheDocument();
    if (interaction === "hover") await user.unhover(tile);
    else await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it.each(["hover", "focus"])("anchors the %s preview to the square instead of the viewport origin", async (interaction) => {
    const user = userEvent.setup();
    setup();
    const tile = screen.getByRole("button");
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(120, 240, 28, 28));
    try {
      if (interaction === "hover") await user.hover(tile);
      else await user.tab();
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.style.top).toBe("240px");
      expect(tooltip.style.left).toBe("134px");
      expect(measure).toHaveBeenCalled();
    } finally {
      measure.mockRestore();
    }
  });

  it("opens read-only detail through click, Enter, and Space", async () => {
    const user = userEvent.setup();
    const { onClick } = setup();
    const tile = screen.getByRole("button");
    await user.click(tile);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("preserves arbitrary types, priorities and participant roles", async () => {
    const user = userEvent.setup();
    setup(card({ card_type: "investigation", priority: "critical-path" }));
    expect(screen.getByRole("button")).toHaveAccessibleDescription(/investigation · critical path · Alice Doe/);
    await user.hover(screen.getByRole("button"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("custom reviewer");
    expect(screen.getByRole("tooltip")).toHaveTextContent("investigation");
    expect(screen.getByRole("tooltip")).toHaveTextContent("critical path");
  });

  it("labels legacy cards without titles honestly", () => {
    setup(card({ title: "", participants: [] }, true));
    expect(screen.getByRole("button", { name: /untitled/i })).toHaveClass("border-dashed");
  });

  it("uses a static spotlight and reveals current actor identity in the tooltip under reduced motion", async () => {
    const user = userEvent.setup();
    setup(card(), {
      selected: true,
      spotlight: { active: true, accentToken: "--color-info", burst: true, actor: { name: "Sam Runner", avatarUrl: null, role: "operator-defined" } },
    });
    const tile = screen.getByRole("button");
    expect(tile).toHaveAttribute("aria-pressed", "true");
    expect(tile.style.boxShadow).toContain("--color-info");
    expect(screen.queryByTestId("spotlight-actor")).toBeNull();
    expect(screen.queryByTestId("particle-burst")).toBeNull();
    await user.hover(tile);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Sam Runner");
    expect(screen.getByRole("tooltip")).toHaveTextContent("operator defined");
  });
});
