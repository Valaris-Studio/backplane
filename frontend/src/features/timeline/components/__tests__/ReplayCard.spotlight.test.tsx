// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import { ReplayCard } from "../ReplayCard";
import type { CardSnapshot, FrameCard } from "../../types";

// Spotlight is an ADDITIVE, optional prop on ReplayCard: when `active` it draws a
// glow + ring (accent-tinted via the token), when `burst` it overlays a
// ParticleBurst, and reduced-motion downgrades to a static ring (no pulse, no
// burst). Absent prop ⇒ unchanged v1 behavior (covered by ReplayCard.test.tsx).

function frameCard(overrides: Partial<CardSnapshot> = {}): FrameCard {
  return {
    snapshot: {
      id: "card1",
      title: "Login crashes on submit",
      card_type: "bug",
      priority: "high",
      column_id: "col1",
      position: 1024,
      status: "in_progress",
      labels: null,
      participants: [],
      ...overrides,
    },
    legacy: false,
  };
}

function setup(spotlight: { active: boolean; accentToken: string; burst: boolean }, reducedMotion = true) {
  return renderWithProviders(
    <ReplayCard
      card={frameCard()}
      selected={false}
      onClick={() => {}}
      reducedMotion={reducedMotion}
      spotlight={spotlight}
    />,
  );
}

describe("ReplayCard — spotlight (additive)", () => {
  it("applies an accent-tinted glow/ring when active", () => {
    const { container } = setup({ active: true, accentToken: "--color-success", burst: false });
    const card = container.querySelector("[data-replay-card='card1']") as HTMLElement;
    // the accent token threads into the inline ring/glow styling (never a literal color)
    expect(card.getAttribute("style") ?? "").toContain("--color-success");
  });

  it("does NOT render a particle burst when not bursting", () => {
    const { container } = setup({ active: true, accentToken: "--color-info", burst: false });
    expect(container.querySelector("[data-testid='particle-burst']")).toBeNull();
  });

  it("renders a particle burst when bursting and motion is allowed", () => {
    const { container } = setup(
      { active: true, accentToken: "--color-info", burst: true },
      false,
    );
    expect(container.querySelector("[data-testid='particle-burst']")).not.toBeNull();
  });

  it("under reduced motion: static ring, never a burst even if burst=true", () => {
    const { container } = setup(
      { active: true, accentToken: "--color-info", burst: true },
      true,
    );
    const card = container.querySelector("[data-replay-card='card1']") as HTMLElement;
    expect(card.getAttribute("style") ?? "").toContain("--color-info");
    expect(container.querySelector("[data-testid='particle-burst']")).toBeNull();
  });

  it("inactive spotlight adds no ring styling", () => {
    const { container } = setup({ active: false, accentToken: "--color-success", burst: false });
    const card = container.querySelector("[data-replay-card='card1']") as HTMLElement;
    expect(card.getAttribute("style") ?? "").not.toContain("--color-success");
  });

  it("shows the actor badge (name · role) on the spotlighted card", () => {
    const { container } = renderWithProviders(
      <ReplayCard
        card={frameCard()}
        selected={false}
        onClick={() => {}}
        reducedMotion={true}
        spotlight={{
          active: true,
          accentToken: "--color-info",
          burst: false,
          actor: { name: "Runner Bot", avatarUrl: null, role: "implementer" },
        }}
      />,
    );
    const badge = container.querySelector("[data-testid='spotlight-actor']") as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toContain("Runner Bot");
    expect(badge.textContent?.toLowerCase()).toContain("implementer");
  });

  it("shows a name-only badge when the acting role is unknown (never guessed)", () => {
    const { container } = renderWithProviders(
      <ReplayCard
        card={frameCard()}
        selected={false}
        onClick={() => {}}
        reducedMotion={true}
        spotlight={{
          active: true,
          accentToken: "--color-info",
          burst: false,
          actor: { name: "Sebastian", avatarUrl: null, role: null },
        }}
      />,
    );
    const badge = container.querySelector("[data-testid='spotlight-actor']") as HTMLElement;
    expect(badge.textContent).toContain("Sebastian");
  });

  it("renders NO actor badge when the spotlight is inactive or the actor is unknown", () => {
    const { container, rerender } = renderWithProviders(
      <ReplayCard
        card={frameCard()}
        selected={false}
        onClick={() => {}}
        reducedMotion={true}
        spotlight={{
          active: false,
          accentToken: "--color-info",
          burst: false,
          actor: { name: "Runner Bot", avatarUrl: null, role: "implementer" },
        }}
      />,
    );
    expect(container.querySelector("[data-testid='spotlight-actor']")).toBeNull();
    rerender(
      <ReplayCard
        card={frameCard()}
        selected={false}
        onClick={() => {}}
        reducedMotion={true}
        spotlight={{ active: true, accentToken: "--color-info", burst: false, actor: null }}
      />,
    );
    expect(container.querySelector("[data-testid='spotlight-actor']")).toBeNull();
  });

  it("CLEARS the ring when the spotlight moves on (motion variant must not keep stale styles)", () => {
    // motion.div doesn't remove an inline style key that simply disappears from
    // the style prop — the regression that left every previously-spotlighted
    // card ringed forever. The emphasis must overwrite with an explicit value.
    const { container, rerender } = renderWithProviders(
      <ReplayCard
        card={frameCard()}
        selected={false}
        onClick={() => {}}
        reducedMotion={false}
        spotlight={{ active: true, accentToken: "--color-info", burst: false }}
      />,
    );
    const card = container.querySelector("[data-replay-card='card1']") as HTMLElement;
    expect(card.style.boxShadow).toContain("--color-info");

    rerender(
      <ReplayCard
        card={frameCard()}
        selected={false}
        onClick={() => {}}
        reducedMotion={false}
        spotlight={undefined}
      />,
    );
    expect(card.style.boxShadow).not.toContain("--color-info");
  });
});
