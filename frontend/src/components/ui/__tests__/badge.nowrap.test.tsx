// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../badge";

// jsdom performs no layout: line boxes never form, so no test here can observe
// a label actually breaking across two lines. These assert the exact style
// properties the fix manipulates — the `whitespace-nowrap` and `shrink-0`
// classes on the rendered element — which is the strongest available signal in
// this environment. Same limitation, same treatment as marquee.test.tsx:23-26.
// The pixel result was confirmed by eye in a browser at a mobile width.
describe("Badge — never wraps its label", () => {
  const LONG_LABEL = "3 agents working on this board right now";

  it("carries whitespace-nowrap so a multi-word label stays on one line", () => {
    render(<Badge>{LONG_LABEL}</Badge>);
    expect(screen.getByText(LONG_LABEL).className).toContain(
      "whitespace-nowrap",
    );
  });

  // shrink-0 is the other half: nowrap alone still lets a flex row squeeze the
  // pill below its intrinsic width and clip the text.
  it("carries shrink-0 so an overflowing row cannot compress it", () => {
    render(<Badge>{LONG_LABEL}</Badge>);
    expect(screen.getByText(LONG_LABEL).className).toContain("shrink-0");
  });

  it("keeps both classes for every variant, not just the default", () => {
    render(
      <Badge variant="outline" className="text-[0.6rem]">
        {LONG_LABEL}
      </Badge>,
    );
    const badge = screen.getByText(LONG_LABEL);
    expect(badge.className).toContain("whitespace-nowrap");
    expect(badge.className).toContain("shrink-0");
  });
});
