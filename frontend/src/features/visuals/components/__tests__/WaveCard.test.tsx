// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { screen, userEvent } from "@/test/test-utils";
import { WaveCard } from "../WaveCard";

// Stub the lazy, motion-backed background; assert the hover→active wiring and
// the layering contract, not the SVG internals.
const lastActive = vi.fn();
vi.mock("../WaveBackground", () => ({
  __esModule: true,
  WaveBackground: ({ active }: { active: boolean }) => {
    lastActive(active);
    return <div data-testid="wave-bg" data-active={active} />;
  },
}));

describe("WaveCard", () => {
  it("renders its children inside an above-the-waves content layer", () => {
    render(
      <WaveCard>
        <span>Hello</span>
      </WaveCard>,
    );
    const child = screen.getByText("Hello");
    expect(child).toBeInTheDocument();
    // Content sits in a z-10 layer so it paints over the wave background.
    expect(child.closest('[data-wave-content="true"]')).toHaveClass("z-10");
  });

  it("clips the waves and positions them behind the content", () => {
    render(
      <WaveCard>
        <span>x</span>
      </WaveCard>,
    );
    const wave = screen.getByTestId("wave-bg");
    // The card root is relative + overflow-hidden so the slice is clipped.
    const root = wave.closest('[data-wave-card="true"]');
    expect(root).toHaveClass("relative", "overflow-hidden");
  });

  it("mounts the waves inactive at rest", () => {
    render(<WaveCard>x</WaveCard>);
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "false");
  });

  it("activates the waves on pointer enter and deactivates on leave", async () => {
    const user = userEvent.setup();
    render(<WaveCard>x</WaveCard>);
    const root = screen.getByTestId("wave-bg").closest('[data-wave-card="true"]')!;

    await user.hover(root);
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "true");

    await user.unhover(root);
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "false");
  });

  it("activates on focus within and deactivates on blur (keyboard parity)", async () => {
    const user = userEvent.setup();
    render(
      <WaveCard>
        <button type="button">focusable</button>
      </WaveCard>,
    );
    await user.tab();
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "true");
    await user.tab();
    expect(screen.getByTestId("wave-bg")).toHaveAttribute("data-active", "false");
  });

  it("merges a caller className onto the card root", () => {
    render(<WaveCard className="h-full border-l-2">x</WaveCard>);
    const root = screen.getByTestId("wave-bg").closest('[data-wave-card="true"]');
    expect(root).toHaveClass("h-full", "border-l-2");
  });
});
