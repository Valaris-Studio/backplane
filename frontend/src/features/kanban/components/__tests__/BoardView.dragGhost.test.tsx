// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import type { Card } from "@/types/kanban";

const reducedMotionState = { value: false };
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => reducedMotionState.value,
}));

const fromToSpy = vi.fn((..._args: unknown[]) => ({ kill: vi.fn() }));
vi.mock("gsap", () => ({
  gsap: {
    fromTo: (...args: unknown[]) => fromToSpy(...args),
    set: vi.fn(),
    registerPlugin: vi.fn(),
  },
}));

import { DragGhost } from "../BoardView";

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: "card-1",
    title: "Carry me",
    description: "",
    card_type: "task",
    priority: "medium",
    position: 1024,
    column_id: "col-1",
    participants: [],
    due_date: null,
    status: null,
    labels: null,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    ...overrides,
  };
}

describe("DragGhost (drag-overlay pickup)", () => {
  beforeEach(() => {
    fromToSpy.mockClear();
    reducedMotionState.value = false;
  });

  it("renders the dragged card inside the overlay wrapper", () => {
    renderWithProviders(<DragGhost card={makeCard()} boardId="b1" />);
    expect(screen.getByText("Carry me")).toBeInTheDocument();
  });

  it("runs the pickup tween on mount (scale up + tilt into carry angle)", () => {
    renderWithProviders(<DragGhost card={makeCard()} boardId="b1" />);
    expect(fromToSpy).toHaveBeenCalledTimes(1);
    const target = fromToSpy.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(target.scale).toBe(1.04);
    expect(target.rotate).toBe(1.5);
    // The shadow must NOT be a tweened string — gsap would interpolate the
    // numbers inside color-mix()/var() names and emit invalid CSS mid-tween.
    // It rides a numeric custom property driving a static overlay's opacity.
    expect(target.boxShadow).toBeUndefined();
    expect(target["--pickup-shadow"]).toBe(1);
  });

  it("hosts the deep shadow on a static overlay whose opacity rides --pickup-shadow", () => {
    const { container } = renderWithProviders(
      <DragGhost card={makeCard()} boardId="b1" />,
    );
    const overlay = container.querySelector("span[aria-hidden]");
    expect(overlay).not.toBeNull();
    const style = (overlay as HTMLElement).style;
    expect(style.boxShadow).toContain("color-mix");
    expect(style.opacity).toContain("--pickup-shadow");
  });

  it("carries a compact row (not a full card) when dragging in compact density", () => {
    const { container } = renderWithProviders(
      <DragGhost card={makeCard()} boardId="b1" density="compact" />,
    );
    const row = container.querySelector("[data-card-root][data-density='compact']");
    expect(row).not.toBeNull();
    expect(screen.getByText("Carry me")).toBeInTheDocument();
  });

  it("falls back to the static tilted wrapper under reduced motion", () => {
    reducedMotionState.value = true;
    const { container } = renderWithProviders(
      <DragGhost card={makeCard()} boardId="b1" />,
    );
    expect(fromToSpy).not.toHaveBeenCalled();
    const wrapper = container.querySelector("div.w-80");
    expect(wrapper?.className).toContain("rotate-1");
  });
});
