// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test/test-utils";
import { EndEditor } from "../EndEditor";

describe("EndEditor", () => {
  it("renders the end-step description", () => {
    renderWithProviders(<EndEditor params={{}} onChange={vi.fn()} />);
    expect(
      screen.getByText(/terminal|end|stop|walk should stop/i),
    ).toBeInTheDocument();
  });

  it("does not nest block content inside a <p> (RichTooltip renders a div)", () => {
    // The description + info tooltip must not sit inside a <p>: RichTooltip's
    // root is a <div>, and <div> inside <p> is invalid HTML that React flags as
    // a hydration/nesting error in the browser (found in visual QA). Assert on
    // the DOM directly — React dedupes the console warning across a run, so a
    // console.error spy is unreliable here.
    const { container } = renderWithProviders(
      <EndEditor params={{}} onChange={vi.fn()} />,
    );
    for (const p of Array.from(container.querySelectorAll("p"))) {
      expect(p.querySelector("div")).toBeNull();
    }
  });
});
