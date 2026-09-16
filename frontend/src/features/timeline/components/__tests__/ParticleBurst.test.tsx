// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import { ParticleBurst } from "../ParticleBurst";

// ParticleBurst is a pure presentational overlay: an absolute, pointer-events-none
// layer of accent-tinted particles. No deps, no React state machine beyond a
// self-removing mount. Reduced motion renders nothing at all.

describe("ParticleBurst", () => {
  it("renders an accent-tinted overlay layer when motion is allowed", () => {
    const { container } = renderWithProviders(
      <ParticleBurst accentToken="--color-success" reducedMotion={false} />,
    );
    const overlay = container.querySelector("[data-testid='particle-burst']");
    expect(overlay).not.toBeNull();
    // accent token threads into the particle styling (never a literal color)
    expect(container.innerHTML).toContain("--color-success");
  });

  it("is non-interactive (pointer-events disabled, absolutely positioned)", () => {
    const { container } = renderWithProviders(
      <ParticleBurst accentToken="--color-info" reducedMotion={false} />,
    );
    const overlay = container.querySelector("[data-testid='particle-burst']") as HTMLElement;
    expect(overlay.className).toContain("pointer-events-none");
    expect(overlay.className).toContain("absolute");
  });

  it("renders NOTHING under reduced motion", () => {
    const { container } = renderWithProviders(
      <ParticleBurst accentToken="--color-success" reducedMotion={true} />,
    );
    expect(container.querySelector("[data-testid='particle-burst']")).toBeNull();
  });

  describe("self-remove + per-step replay", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("self-removes after the burst window so it leaves no dead DOM", () => {
      const { container } = renderWithProviders(
        <ParticleBurst accentToken="--color-info" reducedMotion={false} />,
      );
      expect(container.querySelector("[data-testid='particle-burst']")).not.toBeNull();
      // After the burst window the overlay unmounts itself.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(container.querySelector("[data-testid='particle-burst']")).toBeNull();
    });

    it("replays when remounted via a changed key (the per-step burst fix)", () => {
      // The integration keys the burst on the current event id; a new key mounts
      // a FRESH ParticleBurst, so a repeat-target card bursts again each step
      // rather than latching after its first play.
      const { container, rerender } = renderWithProviders(
        <ParticleBurst key="step-1" accentToken="--color-info" reducedMotion={false} />,
      );
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(container.querySelector("[data-testid='particle-burst']")).toBeNull();

      rerender(
        <ParticleBurst key="step-2" accentToken="--color-info" reducedMotion={false} />,
      );
      expect(container.querySelector("[data-testid='particle-burst']")).not.toBeNull();
    });
  });
});
