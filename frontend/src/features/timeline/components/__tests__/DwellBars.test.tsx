// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { DwellBars } from "../DwellBars";

// gsap is mocked so we can assert the grow-in tween's shape without a real
// ticker; the component only touches fromTo (entrance) and set (clearProps).
const { fromToMock, killMock, setMock } = vi.hoisted(() => {
  const killMock = vi.fn();
  return {
    killMock,
    fromToMock: vi.fn(() => ({ kill: killMock })),
    setMock: vi.fn(),
  };
});
vi.mock("gsap", () => ({ gsap: { fromTo: fromToMock, set: setMock } }));

const originalMatchMedia = window.matchMedia;

function stubReducedMotion(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

const dwellByColumn = { col1: 60_000, col2: 30_000 };
const columnNames = { col1: "Backlog", col2: "Done" };

beforeEach(() => {
  vi.clearAllMocks();
  stubReducedMotion(false);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("DwellBars grow-in", () => {
  it("tags each bar fill for the stagger tween", () => {
    const { container } = renderWithProviders(
      <DwellBars dwellByColumn={dwellByColumn} columnNames={columnNames} />,
    );
    expect(container.querySelectorAll("[data-dwell-fill]")).toHaveLength(2);
  });

  it("grows the fills from scaleX 0 with a stagger", () => {
    renderWithProviders(
      <DwellBars dwellByColumn={dwellByColumn} columnNames={columnNames} />,
    );

    expect(fromToMock).toHaveBeenCalledTimes(1);
    const [targets, fromVars, toVars] = fromToMock.mock.calls[0] as unknown as [
      NodeListOf<Element>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(targets).toHaveLength(2);
    expect(fromVars).toMatchObject({ scaleX: 0 });
    expect(toVars).toMatchObject({
      scaleX: 1,
      transformOrigin: "left center",
    });
    expect(toVars.stagger).toBeGreaterThan(0);
  });

  it("skips the tween entirely under reduced motion (bars stay static)", () => {
    stubReducedMotion(true);
    renderWithProviders(
      <DwellBars dwellByColumn={dwellByColumn} columnNames={columnNames} />,
    );

    expect(fromToMock).not.toHaveBeenCalled();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("re-runs the tween when a different card's dwell rows arrive", () => {
    const { rerender } = renderWithProviders(
      <DwellBars dwellByColumn={dwellByColumn} columnNames={columnNames} />,
    );
    expect(fromToMock).toHaveBeenCalledTimes(1);

    rerender(
      <DwellBars
        dwellByColumn={{ col3: 45_000 }}
        columnNames={{ col3: "Review" }}
      />,
    );
    expect(fromToMock).toHaveBeenCalledTimes(2);
  });

  it("kills the tween and clears transforms on unmount", () => {
    const { unmount } = renderWithProviders(
      <DwellBars dwellByColumn={dwellByColumn} columnNames={columnNames} />,
    );
    unmount();

    expect(killMock).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clearProps: "transform" }),
    );
  });
});
