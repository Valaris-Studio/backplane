// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { WaveBackground } from "../WaveBackground";

// Stand in for the heavy, motion-backed GradientWaves so the test stays fast
// and asserts the lazy-mount contract rather than the SVG internals. The mock
// also lets us prove the module is only pulled in when active.
const wavesMounted = vi.fn();
vi.mock("../GradientWaves", () => ({
  __esModule: true,
  default: ({ className }: { className?: string }) => {
    wavesMounted();
    return <div data-testid="gradient-waves" className={className} />;
  },
}));

describe("WaveBackground", () => {
  it("renders nothing and does not mount the waves when inactive", () => {
    wavesMounted.mockClear();
    const { container } = render(<WaveBackground active={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(wavesMounted).not.toHaveBeenCalled();
  });

  it("lazily mounts the waves when active", async () => {
    wavesMounted.mockClear();
    render(<WaveBackground active />);
    expect(await screen.findByTestId("gradient-waves")).toBeInTheDocument();
    expect(wavesMounted).toHaveBeenCalled();
  });

  it("applies the className to the positioning wrapper", async () => {
    render(<WaveBackground active className="absolute inset-0" />);
    const waves = await screen.findByTestId("gradient-waves");
    // The wrapper carries the caller's positioning class; the waves fill it.
    const wrapper = waves.parentElement;
    expect(wrapper).toHaveClass("absolute", "inset-0");
    expect(waves).toHaveClass("h-full", "w-full");
  });
});
