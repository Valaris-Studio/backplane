// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge, badgeVariants, BADGE_SIZE_SM, BADGE_SIZE_MD } from "../badge";

// jsdom computes no styles from Tailwind classes, so no test here can read
// back a rendered font size. These assert the exact class the size axis
// manipulates on the exact element, which is the strongest available signal in
// this environment. Same limitation, same treatment as marquee.test.tsx:23-26
// and badge.nowrap.test.tsx. The pixel result was confirmed by eye.
describe("Badge — size axis", () => {
  const LABEL = "backlog";

  it("defaults to the md size so every untouched call site is unchanged", () => {
    render(<Badge>{LABEL}</Badge>);
    const badge = screen.getByText(LABEL);
    expect(badge.className).toContain(BADGE_SIZE_MD);
    expect(badge.className).not.toContain(BADGE_SIZE_SM);
  });

  // Mutually exclusive: the size literal lives only in the variant, never in
  // the shared base string, so a size choice can never be half-overridden.
  it('size="sm" carries the small size and drops the md one entirely', () => {
    render(<Badge size="sm">{LABEL}</Badge>);
    const badge = screen.getByText(LABEL);
    expect(badge.className).toContain(BADGE_SIZE_SM);
    expect(badge.className).not.toContain(BADGE_SIZE_MD);
  });

  it("the two size tokens are distinct values", () => {
    expect(BADGE_SIZE_SM).not.toBe(BADGE_SIZE_MD);
  });

  // Asserted against badgeVariants' RAW output rather than a rendered element,
  // because <Badge> pipes its classes through `cn` (tailwind-merge), which
  // silently drops a duplicate `text-*` and would hide a size literal leaking
  // back into the shared base string. The leak is benign at runtime precisely
  // because of that merge, but it defeats the axis's design contract — a size
  // choice must be expressed in exactly one place — so it is pinned at the
  // source the contract lives in.
  it("keeps the size literal out of the shared base string", () => {
    const smClasses = badgeVariants({ size: "sm" }).split(" ");
    const mdClasses = badgeVariants({ size: "md" }).split(" ");

    expect(smClasses).toContain(BADGE_SIZE_SM);
    expect(smClasses).not.toContain(BADGE_SIZE_MD);
    expect(mdClasses).toContain(BADGE_SIZE_MD);
    expect(mdClasses).not.toContain(BADGE_SIZE_SM);
  });

  it("the size axis is orthogonal to the variant axis", () => {
    render(
      <Badge variant="outline" size="sm">
        {LABEL}
      </Badge>,
    );
    const badge = screen.getByText(LABEL);
    expect(badge.className).toContain(BADGE_SIZE_SM);
    expect(badge.className).toContain("border-border/70");
  });
});
